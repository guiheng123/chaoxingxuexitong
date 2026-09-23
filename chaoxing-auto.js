// ==UserScript==
// @name         超星学习通 · 自动刷课 + 自定义API答题
// @namespace    local.chaoxing.auto
// @version      1.6.1
// @description  自动播放/静音/倍速/防暂停/自动下一节；答题支持直连大模型（内置提示词，只需填地址+密钥）或自定义接口
// @license MIT
// @author       guiheng123
// @match        *://*.chaoxing.com/*
// @match        *://*.chaoxing.com.cn/*
// @match        *://*.chaoxing.com:8080/*
// @match        *://*.chaoxing.cn/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @connect      *
// @run-at       document-end
// ==/UserScript==

/*
 * 设计说明（为什么这么写）
 * ------------------------------------------------------------------
 * 1) 超星的课程页是「顶层壳 + 多个跨域 iframe」的结构：
 *      顶层 studentstudy  →  iframe: /ananas/modules/video/...  (视频)
 *                         →  iframe: /ananas/modules/work/...   (作业/测验)
 *                         →  iframe: /ananas/modules/read/...   (阅读：书单 + 阅读时长，不可自动化)
 *    跨域 iframe 之间无法直接调用对方 DOM，因此本脚本采用「每个 frame 独立注入 + 各自识别自己的角色」的
 *    方案，frame 之间只通过 GM 存储（GM_setValue / GM_addValueChangeListener）传递信号，绕开跨域限制。
 *
 * 2) 视频进度**不伪造上报**。超星自己的播放器会按 timeupdate 上报 playingTime，
 *    我们只保证「视频真的在播、不被暂停、不被判为切屏」，这样上报数据天然是合法的。
 *    伪造 log 接口风险高且极易被风控，不做。
 *
 * 3) 答题走「抓题 → 调外部 API → 回填 → 提交」，有两种模式（面板可切）：
 *
 *      'ai'     —— 直连大模型，**默认**。用户只填「地址 + 密钥 + 模型」，其余全内置：
 *                  端点自动补 /chat/completions、Authorization 头、内置提示词、响应解析。
 *                  之所以不把这层暴露给用户，是因为 OpenAI 兼容格式已是事实标准，
 *                  让用户自己拼请求体只会让配置变复杂、错得更多。
 *      'custom' —— 自定义接口（高级）。地址/请求头/请求体模板/响应路径全自己配，
 *                  用于接自建题库或格式不兼容 OpenAI 的网关。
 *
 *    两条路径的"模型输出 → 可回填答案"都由同一组纯函数负责（见「AI 答题纯函数」区块），
 *    那段被刻意写成无副作用的形式，好让 bench/ai-answer-test.js 穷举各种畸形响应。
 *
 * 4) 【任务完成判定 —— 最容易写错的地方】
 *
 *    **"媒体播完"不等于"任务点完成"。** 视频 ended 只说明播放器播到头了，
 *    超星还要把进度上报给服务器、服务器确认后才把任务点标记为完成。
 *
 *    所以**自动下一节只看一个东西：目录里当前章节的完成标记** —— 它由超星自己
 *    根据服务器状态渲染，是唯一权威依据。显示已完成 → 模拟点击「下一节」；
 *    没显示 → 什么都不做，继续等。判定收在第 8 节 NextModule 的**唯一一个循环**里。
 *
 *    也**绝对不要**用"页面上有『下一节』按钮"当作完成依据 —— 超星的章节导航按钮是
 *    **常驻**的，一直挂在页面上，拿它当信号等于无条件跳转。
 *    （v1.2.0 的 domWatch 就犯了这个错；"页面提示兜底跳转"这个开关在 v1.5.0 已删除。）
 *
 *    视频 / 文档模块自己仍有一道**本地**确认流程（到达末尾 → 等上报沉淀 →
 *    校验所有分段都结束 → 等"已完成"标记，见 VideoModule.onMediaEnd）。它只决定
 *    "这个任务点我这边收工了没有"，**不再决定要不要跳转** —— 那是第 8 节唯一的事。
 *
 * 5) 【性能与稳定性约束 —— 改代码前务必先读这段】
 *    这个脚本会同时跑在超星页面的**每一个** frame 里，而超星本身是重 DOM 的重应用，
 *    所以任何"每次 DOM 变更都执行"或"和页面无限拉锯"的逻辑，都会被放大成卡顿甚至内存溢出。
 *    四条硬规矩：
 *
 *    a) **禁止用 MutationObserver 观察 document.documentElement / body**。
 *       播放器每秒会产生几十次 DOM 变更，观察整棵树等于让浏览器为每次变更排队、并在微任务里
 *       回调一次全文档查询。需要等元素出现就用 waitFor()，需要检测元素失效就在已有定时器里查
 *       isConnected。v1.0.0 就是因为这条卡到不可用。
 *
 *    b) **禁止在热路径上调用 GM_getValue / GM_setValue**。GM 存储是同步阻塞的，每次还要把值
 *       序列化/反序列化一遍。日志这类高频写入必须先进内存队列、再合并落盘（见 pushLog）。
 *
 *    c) **禁止任何无熔断的对抗逻辑**。所有"页面做了 A 我就做 B"的代码都必须先过 breaker.allow()。
 *       v1.1.0 的退避写法有致命漏洞：只要两次触发间隔超过阈值，计数就被重置，于是
 *       "页面每 1.5 秒暂停一次"永远不会触发停手条件，play↔pause 无限拉锯，
 *       每次循环都创建事件对象和闭包，主线程占满、GC 跟不上 → **内存溢出、标签页崩溃**。
 *       现在统一用滑动窗口计数，窗口内超限直接熔断。
 *
 *    d) **定时器必须从 Timers 创建**，不要直接用 setInterval/setTimeout。
 *       这样面板能显示实时定时器数量（泄漏时这个数字会异常增长），「紧急停止」也能一次清干净。
 */

(function () {
  'use strict';

  /* ============================================================
   * 0. 默认配置
   * ============================================================ */

  /*
   * 内置提示词。
   *
   * 关键设计：**强制模型只输出 JSON 数组**。
   * 自然语言的答案（"我认为选 A，因为…"）无法可靠解析成可回填的选项字母，
   * 所以把输出格式写死进提示词，解析层再做一次容错（见 parseAnswersFromText）。
   *
   * 另外刻意要求"不确定也必须给答案"：空答案会让 fillOne 直接跳过该题，
   * 与其漏填，不如让模型给一个最可能的选项 —— 至少还能对。
   *
   * 用户可在面板里改这份提示词（promptTemplate），改坏了有「恢复默认」。
   */
  const DEFAULT_PROMPT = [
    '你是一个答题助手。用户会给你一个 JSON 数组，每个元素是一道题，',
    '包含 id、type、question、options 字段。',
    '',
    '请逐题作答，只输出一个 JSON 数组，不要输出任何解释、前后缀或 Markdown 代码块标记。',
    '',
    '输出格式（严格遵守）：',
    '[{"id":"q1","answer":"A"},{"id":"q2","answer":"ABD"}]',
    '',
    '作答规则：',
    '- id 必须与题目里的 id 完全一致，不能增、删、改。',
    '- type=single（单选）：answer 为单个选项字母，如 "A"。',
    '- type=multi（多选）：answer 为多个选项字母连写，如 "ABD"，不要加逗号或空格。',
    '- type=judge（判断）：answer 写 "对" 或 "错"。',
    '- type=blank（填空）：多个空按先后顺序用 "|" 分隔。',
    '- type=essay（简答/论述）：answer 为简明答案文本。',
    '- 即使不确定也必须给出最可能的答案，不要留空、不要写"无法确定"。',
  ].join('\n');

  const DEFAULT_CONFIG = {
    // ---- 视频 ----
    videoEnabled: true,
    videoMute: true,           // 静音（浏览器允许静音自动播放）
    videoSpeed: 2,             // 倍速，1 / 1.25 / 1.5 / 2。超过 2 有被判异常的风险
    keepPlaying: true,         // 被暂停/切屏后自动恢复播放（带熔断，不会和页面拉锯）
    /*
     * 视频已有播放进度时，尝试直接跳到结尾**一次**。
     *
     * 超星会记住每个视频的播放位置，重新打开任务点时播放器从上次位置继续。
     * 既然已经有进度，就没必要再从头走一遍 —— 直接 seek 到末尾，让播放器上报"已播完"。
     *
     * 两个已知的不确定性，所以设计成"只试一次 + 失败自动退回"：
     *  1) 超星按累计 playingTime 算进度，seek 不一定能补上缺的那一段，服务器可能不认；
     *  2) 直接跳到末尾属于异常播放轨迹，有小概率被判定为刷课。
     * 跳完仍然走完整的完成确认流程；确认不通过会自动退回原位置继续播（见 fallbackFromJump）。
     */
    videoJumpToEnd: true,
    /* 判定"已有播放进度"的最小秒数。低于这个值当作从头开始，不跳 */
    videoJumpMinProgress: 5,
    autoNext: true,            // 本节确认完成后自动切下一节
    nextDelay: 4000,           // 确认完成后，再等多少毫秒切下一节
    /*
     * 侵入式反暂停：篡改 document.hidden / visibilityState 并拦截 visibilitychange。
     *
     * **默认关闭**，原因有两个：
     *  1) 它是冗余的 —— 切标签页导致暂停的场景，pause 恢复已经能兜住；
     *  2) 它有副作用 —— 页面若依赖 document.hidden 判断"何时该清理资源/何时该上报"，
     *     被强行改成永远可见之后，清理分支可能永远不执行，导致页面自己泄漏内存。
     * 只在 pause 恢复确实压不住切屏暂停时，才建议打开。
     */
    aggressiveAntiPause: false,

    // ---- 任务完成判定 ----
    /*
     * 视频 / 文档的**本地**完成确认：等页面出现"已完成"标记再收工。
     *
     * ⚠️ v1.5.0 起它**不再**决定要不要跳转。自动下一节只看目录上的完成标记
     * （见第 8 节），这个开关现在只影响视频 / 文档模块自己的确认流程
     * （视频确认通过后会顺手点一次 iframe 内部的「下一节」）。
     */
    requireComplete: true,
    reportSettleMs: 8000,      // 视频播完后额外停留时间，等超星把进度上报完
    completeWaitMs: 25000,     // 等待"已完成"标记出现的最长时间
    /*
     * 完成标记选择器。默认只给一组**具体**类名，故意不加 [class*="complete"] 这类宽泛匹配 ——
     * 宽泛匹配很容易命中无关的装饰元素，导致"其实没完成却判成完成"，那正是要避免的抢跑。
     * 找不到宁可停在原地等。用面板的「诊断」按钮能看到每个选择器命中了几个元素，据此补充。
     */
    completeSelectors: '.icon_Completed,.icon_Complete,.completed,.task_complete,.finishIcon',

    // ---- 文档 / PPT 阅读 ----
    docEnabled: true,          // 自动翻页阅读类任务点
    docPageDelay: 3000,        // 每页停留毫秒

    // ---- 答题 ----
    /*
     * 答题有两种模式：
     *
     *   'ai'     —— 直连大模型（OpenAI 兼容接口），**默认**。
     *               用户只需要填「地址 + 密钥 + 模型」三样，请求体、鉴权头、
     *               提示词、响应解析全部内置。地址会自动补 /chat/completions，
     *               所以填 base（如 https://api.openai.com/v1）就行。
     *
     *   'custom' —— 自定义接口（高级）。
     *               地址/方法/请求头/请求体模板/响应路径全部自己配，
     *               用于接自建题库、或格式不兼容 OpenAI 的网关。
     *               这一套是 v1.3.0 的行为，原样保留，没动过。
     */
    answerEnabled: false,
    /*
     * 在每道题旁边显示 AI 作答进度徽标。
     * 默认开 —— 答题中间那段 API 往返是完全静默的，没有徽标用户只能反复点诊断。
     * 徽标会往页面里插元素，所以给一个关掉的口子。
     */
    showProgress: true,
    /*
     * 作答方式：
     *   'per'   逐题作答（默认）—— 一次请求只发一道题，拿到答案立刻回填
     *   'batch' 整卷一次 —— 所有题打包成一个请求
     *
     * 逐题的好处：进度可见、单题失败不连坐、重试只重发失败那道。
     * 代价是 N 次往返，所以保留 batch 作为可选项。
     */
    answerMode: 'per',
    /* 逐题模式下，某道题没答上时额外重试几次（超过就放弃，不再无限打接口） */
    answerRetries: 2,
    /*
     * 演练模式（dry run）。
     *
     * 开着时：照常抓题、照常调 API，但**不点任何选项、不提交**，
     * 只把"每道题打算填什么、元素找没找到"打进日志。
     *
     * 为什么需要它：脚本的作答对象是用户的真实测验 —— 而章节测验往往只能提交一次。
     * 想验证"选择器对不对 / 答案能不能落到选项上"，又不想拿真实成绩做实验，
     * 就得有这么一条只读通路。排查"回填失败"时它是第一手段。
     */
    dryRun: false,
    apiMode: 'ai',

    // ---- 答题 · AI 模式 ----
    apiUrl: 'https://api.openai.com/v1',
    apiKey: '',
    apiModel: 'gpt-4o-mini',
    apiUrlFull: false,         // 勾上表示地址已是完整端点，不再自动补 /chat/completions
    promptTemplate: DEFAULT_PROMPT,
    apiTimeout: 60000,         // 大模型比题库慢，默认给到 60s（旧版 30s 经常不够）

    // ---- 答题 · 自定义模式（高级） ----
    apiUrlCustom: 'https://your-api.example.com/answer',
    apiMethod: 'POST',
    apiHeaders: '{\n  "Content-Type": "application/json",\n  "Authorization": "Bearer YOUR_TOKEN"\n}',
    // 请求体模板：{{questions}} 会被替换成题目数组的 JSON
    apiBodyTemplate: '{\n  "questions": {{questions}}\n}',
    // 响应解析：结果数组在响应 JSON 里的路径（点号分隔），留空表示响应本身就是数组
    respPath: 'data',
    respIdKey: 'id',
    respAnswerKey: 'answer',

    // ---- 答题 · 通用 ----
    autoSubmit: true,          // 填完自动点提交
    submitDelay: 2000,         // 填完后等待毫秒再提交
    submitConfirm: false,      // 提交前是否弹确认（手动模式用）
    submitWaitMs: 20000,       // 提交后等待"提交成功"确认的最长时间
    fallbackAnswer: '',        // API 无结果时的兜底答案，如 "A"，留空则跳过该题

    // ---- 其它 ----
    debug: false,              // 输出 console 日志。排查问题时再打开
    logEnabled: true,          // 收集运行日志到面板。完全不想有日志开销可以关掉
    panelCollapsed: false,
  };

  const STORE_KEY = 'cx_auto_config';
  const LOG_KEY = 'cx_auto_logbuf';
  /*
   * 版本号在代码里的唯一来源。
   *
   * 必须和文件头的 @version 保持一致 —— 之前导出日志里硬编码了 "1.4.2"，
   * 升到 1.4.3 时就漏改了，用户拿到的日志会标错版本，排查时被误导。
   * bench/version-test.js 会强制校验这两处相等。
   */
  const SCRIPT_VERSION = '1.6.1';
  /*
   * v1.3.0 答题配置里的占位地址。
   * 它跟 v1.4.0 的默认值不同，所以在做"用户是否改过地址"的判断时必须显式排除，
   * 否则一个从没配过答题的老用户会被误判成"自定义接口用户"。
   * （bench/config-migration-test.js 就是冲着这个坑写的）
   */
  const LEGACY_PLACEHOLDER_URL = 'https://your-api.example.com/answer';
  /*
   * 重新执行信号：面板 → 所有 frame。
   *
   * 面板只挂在顶层，但干活的模块在子 frame 里。原来「重新执行」按钮直接调顶层的
   * WorkModule.loop()，而顶层根本没有题目容器 —— 点了等于没点。
   * 现在改成写一个时间戳，各 frame 监听到就按自己的角色重新跑一遍。
   */
  const EVT_RETRY = 'cx_auto_retry';
  /*
   * 各 frame 的状态上报。
   *
   * 这是排查"脚本无反应"最关键的一块 —— 面板挂在顶层，而干活的模块在子 frame 里，
   * 顶层**看不到** iframe 内部发生了什么。没有这个机制时，用户只能报"没反应"，
   * 而我们无法区分下面这几种完全不同的情况：
   *   a) 脚本压根没注入到测验 iframe（Tampermonkey 权限 / @match 不匹配）
   *   b) 注入了，但角色判错，模块没启动
   *   c) 模块启动了，但题目在更深一层的 iframe 里，这个 frame 里永远是 0
   *   d) 模块正常在等，题目确实还没渲染出来
   * 有了上报，诊断里一眼就能区分。
   */
  const FRAME_KEY = 'cx_auto_frames';
  const EVT_REPORT = 'cx_auto_report_req';
  /*
   * 目录状态广播：顶层 → 所有 frame。
   *
   * 方向是**顶层 → 子 frame**：顶层**能看到目录**（章节列表上的完成图标），
   * 子 frame 看不到。
   *
   * 为什么需要：作业/测验跑在 iframe 里，它没法知道"这个任务点在目录里已经打勾了"。
   * 于是用户打开一个**早就做完**的任务点，脚本会认认真真再答一遍 ——
   * 而如果开了自动提交，还会把已交的答案**覆盖**掉。
   *
   * 注意存的是**状态**不是事件：子 frame 随时可能才注入，得能读到当前值。
   * 顶层只在状态变化时写入，不轮询刷存储。
   */
  const EVT_CHAPTER_DONE = 'cx_auto_chapter_done';

  /*
   * 「本任务点已经点过提交」的持久记录（谁点的都算：脚本或用户自己）。
   *
   * 为什么不能只靠内存里的 `done`：完成判定原先全部依赖**页面上的正向证据**，
   * 而这些证据在两种情况下会一起消失 ——
   *   1) 超星提交后重载/跳转 iframe → 脚本是新实例，`done` 和 `handled` 全丢；
   *   2) 结果页把题目原样留在 DOM 里，却没有任何"已完成"字样。
   * 于是脚本把已经交过的卷子重新答一遍；开着自动提交还会**再交一次**。
   *
   * 记录写在点击提交**之前** —— 点完页面可能立刻跳走，来不及写。
   * 所以它区分 `confirmed`：拿到成功确认的才算"已提交"，没拿到的是"点过、未确认"。
   */
  const EVT_SUBMITTED = 'cx_auto_submit_latch';

  /*
   * 能唯一定位"一个任务点"的 URL 参数。
   *
   * ⚠️ 刻意**不含** `courseId` / `classId` / `chapterId`：
   * 它们的作用域比任务点大 —— 拿它们当键，会让"同一个章节里另一个任务点"
   * 被上一条记录误拦，表现为"该答的卷子不答了"，而用户不会知道。
   * 这类错误的代价远大于"多答一次"，所以宁可认不出来（见 taskKey 的返回值约定）。
   */
  const TASK_KEY_PARAMS = [
    'workId', 'workid', 'jobid', 'jobId', 'taskId',
    'examId', 'examRelationId', 'workRelationId',
    'objectId', 'knowledgeId', 'job',
  ];

  /**
   * 当前 frame 所在**任务点**的标识；认不出来返回 `''`。
   *
   * 约定：返回空串表示"无法安全定位任务点"，调用方必须**放弃**加闸门，
   * 而不是退化成用路径或课程 ID 兜底 —— 见 TASK_KEY_PARAMS 的说明。
   */
  function taskKey() {
    let href = '';
    try { href = String(location.href || ''); } catch (e) { return ''; }
    const qi = href.indexOf('?');
    if (qi < 0) return '';
    const path = href.slice(0, qi);
    const picked = [];
    for (const kv of href.slice(qi + 1).split('&')) {
      const eq = kv.indexOf('=');
      if (eq <= 0) continue;
      const k = kv.slice(0, eq);
      if (TASK_KEY_PARAMS.indexOf(k) < 0) continue;
      picked.push(k + '=' + kv.slice(eq + 1));
    }
    if (!picked.length) return '';
    picked.sort();   // 参数顺序不该影响标识
    return path + '?' + picked.join('&');
  }

  /**
   * 诊断用：把「本任务点已点过提交」的记录描述成一行。
   *
   * 必须能区分三种情况，否则"脚本还在答题"根本没法定位：
   *   · 命中本任务点 → 闸门会生效；
   *   · 有记录但属于别的任务点 → 说明 taskKey() 认错了（要么会误拦别的卷子，
   *     要么该拦的拦不住），这是改 TASK_KEY_PARAMS 的直接依据；
   *   · 完全没有记录 → 说明提交那一步根本没走到，或者当时没认出任务点。
   */
  function submitLatchReport() {
    let s = null;
    try { s = GM_getValue(EVT_SUBMITTED, null); } catch (e) { return '读不到存储'; }
    if (!s || !s.at) return '无（本任务点还没点过提交）';
    const mins = Math.max(1, Math.round((Date.now() - s.at) / 60000));
    const tag = s.confirmed ? '已确认' : '未确认';
    const k = taskKey();
    if (!k) return `有（${mins} 分钟前，${tag}），但**认不出本任务点标识** → 不会用来拦作答`;
    return s.key === k
      ? `命中本任务点（${mins} 分钟前，${tag}）→ 会停止作答`
      : `有，但属于别的任务点（${mins} 分钟前，${tag}）→ 不拦`;
  }

  /* ============================================================
   * 1. 基础工具
   * ============================================================ */

  const isTop = (() => {
    try { return window.top === window.self; } catch (e) { return false; }
  })();

  function safeJson(o) {
    try { return JSON.stringify(o); } catch (e) { return String(o); }
  }

  function fmt(...args) {
    return args.map((a) => (typeof a === 'object' ? safeJson(a) : String(a))).join(' ');
  }

  function log(...args) {
    const msg = fmt(...args);
    if (CONFIG.debug) console.log('%c[超星助手]', 'color:#4c8bf5;font-weight:bold', msg);
    pushLog(msg);
  }

  /*
   * warn 也做节流。
   * 原本是无条件 console.warn，而有些 warn 挂在会反复触发的事件上（比如 video 的 error、
   * 播放卡住）。DevTools 打开时，每条 console 记录都会被保留并关联调用栈，高频 warn
   * 本身就能吃掉大量内存。现在同一条消息 5 秒内只输出一次。
   */
  const warnSeen = new Map();

  function warn(...args) {
    const msg = fmt(...args);
    const now = Date.now();
    const last = warnSeen.get(msg) || 0;
    if (now - last > 5000) {
      console.warn('[超星助手]', msg);
      if (warnSeen.size > 100) warnSeen.clear();   // 防止这个 Map 自己变成泄漏源
      warnSeen.set(msg, now);
    }
    pushLog('⚠ ' + msg);
  }

  /* ============================================================
   * 1.5 熔断器 + 定时器登记表
   * ============================================================ */

  /*
   * 熔断器：所有"和页面互相较劲"的逻辑都必须先过这道闸门。
   *
   * v1.1.0 的退避写法是"距离上次触发不足 1.2 秒才累加计数"，这有个致命漏洞：
   * 只要页面以略大于 1.2 秒的节奏触发（比如每 1.5 秒暂停一次视频、每 2 秒把倍速改回去），
   * 计数每次都被重置，永远不会达到停手条件 → 无限拉锯 → 每次循环创建事件对象和闭包
   * → 主线程占满、GC 跟不上 → 内存持续上涨直到标签页崩溃。
   *
   * 现在改成滑动窗口：不管触发间隔多长，只要窗口内次数超限就熔断该动作。
   * 熔断后不会自动恢复（切章节会 reset），并在日志里说明原因。
   */
  const breaker = {
    buckets: new Map(),

    allow(name, limit, windowMs) {
      const now = Date.now();
      let b = this.buckets.get(name);
      if (!b) { b = { times: [], tripped: false }; this.buckets.set(name, b); }
      if (b.tripped) return false;

      // 滑动窗口：丢掉过期的时间戳
      let i = 0;
      while (i < b.times.length && now - b.times[i] >= windowMs) i++;
      if (i) b.times.splice(0, i);

      if (b.times.length >= limit) {
        b.tripped = true;
        warn(`[熔断]「${name}」在 ${windowMs / 1000}s 内触发 ${b.times.length} 次，已停用。` +
             '这通常意味着脚本正在和页面互相拉锯，继续下去会打满 CPU 并耗尽内存。' +
             '建议把倍速降到 1.25x，或关闭「防暂停」');
        return false;
      }
      b.times.push(now);
      return true;
    },

    reset(name) {
      if (name) this.buckets.delete(name);
      else this.buckets.clear();
    },

    snapshot() {
      if (!this.buckets.size) return '无';
      const out = [];
      for (const [name, b] of this.buckets) {
        out.push(`${name}: ${b.tripped ? '已熔断' : b.times.length + ' 次'}`);
      }
      return out.join(' / ');
    },
  };

  /*
   * 定时器登记表。所有长期定时器都从这里创建，好处有两个：
   *  1) 面板能显示当前有多少个定时器在跑 —— 真出现泄漏时这个数字会异常增长，是最快的判断依据
   *  2) 「紧急停止」能一次清干净，不用关标签页
   */
  const Timers = {
    ids: new Set(),

    every(fn, ms) {
      const id = setInterval(fn, ms);
      this.ids.add(id);
      return id;
    },

    after(fn, ms) {
      let id;
      id = setTimeout(() => { this.ids.delete(id); fn(); }, ms);
      this.ids.add(id);
      return id;
    },

    clear(id) {
      clearInterval(id);
      clearTimeout(id);
      this.ids.delete(id);
    },

    clearAll() {
      for (const id of this.ids) { clearInterval(id); clearTimeout(id); }
      this.ids.clear();
      logFlushTimer = null;
    },

    count() { return this.ids.size; },
  };

  /* ============================================================
   * 1.6 日志：内存队列 + 节流落盘
   * ============================================================ */

  /*
   * v1.0.0 是每次 log 都 GM_getValue + GM_setValue，而 GM 存储是同步阻塞调用，
   * 每次还要把整个数组序列化/反序列化。日志一密集就会把主线程堵住。
   * 现在改成先进内存队列，最多 800ms 合并写一次，把 N 次存储写入压成 1 次。
   */
  const logQueue = [];
  let logFlushTimer = null;

  function pushLog(msg) {
    if (!CONFIG.logEnabled) return;
    logQueue.push(`[${new Date().toLocaleTimeString()}] ${msg}`);
    while (logQueue.length > 200) logQueue.shift();
    if (logFlushTimer) return;
    logFlushTimer = Timers.after(flushLogs, 800);
  }

  function flushLogs() {
    logFlushTimer = null;
    if (!logQueue.length) return;
    try {
      const buf = GM_getValue(LOG_KEY, []);
      const next = buf.concat(logQueue.splice(0, logQueue.length));
      GM_setValue(LOG_KEY, next.slice(-120));
    } catch (e) {
      logQueue.length = 0;   // 存储不可用就别再攒了，避免无限增长
    }
  }

  /*
   * 日志缓冲的「变化指纹」。
   *
   * 为什么不能只看条数：上面 flushLogs 把缓冲硬截在 120 条（next.slice(-120)）。
   * 写满之后条数**恒为 120** —— 新日志不断把最老的挤出去，缓冲内容一直在变，
   * 但长度永远不变。任何「长度没变就当没变」的判断，到那一刻起就永远为真，
   * 于是面板的日志区**永久冻结**，直到用户手动点「清空日志」。
   *
   * 真机复现（v1.5.2，2026-09-22）：灌满 120 条后再产 10 条，日志区内容逐字节
   * 不变（长度 1649 / 60 行 / sha1 前缀一致）；点一次「清空日志」立刻恢复。
   * 用户看到的现象是「脚本没反应了」—— 而脚本一切正常，心跳、跳转、答题都在跑。
   * 这是最难查的一类故障：**观测工具自己坏了，却表现为被观测对象坏了**。
   *
   * 所以指纹必须包含首尾两条：缓冲写满后，两端都会随新日志变化。
   */
  function logSignature(buf) {
    if (!buf || !buf.length) return '0||';
    return buf.length + '|' + buf[0] + '|' + buf[buf.length - 1];
  }

  /**
   * 等待某个元素出现。
   *
   * 用轮询而不是 MutationObserver —— 超星的 DOM 是异步渲染的，但观察整个文档代价太大。
   * 间隔按 1.5 倍指数退避（300ms → 3s 封顶），把 30 秒窗口内的查询次数从 ~100 次压到 ~12 次。
   */
  function waitFor(getter, { timeout = 20000, interval = 300, maxInterval = 3000 } = {}) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      let wait = interval;
      const tick = () => {
        let el = null;
        try { el = typeof getter === 'function' ? getter() : document.querySelector(getter); } catch (e) { el = null; }
        if (el) return resolve(el);
        if (Date.now() - t0 > timeout) return resolve(null);
        Timers.after(tick, wait);
        wait = Math.min(wait * 1.5, maxInterval);
      };
      tick();
    });
  }

  /** 按 "a.b.c" 路径取值，兼容数组下标 */
  function deepGet(obj, path) {
    if (!path) return obj;
    return path.split('.').reduce((acc, k) => {
      if (acc == null) return undefined;
      return acc[k];
    }, obj);
  }

  function normalizeUrl(u) {
    if (!u) return '';
    if (/^https?:\/\//i.test(u)) return u;
    if (/^\/\//.test(u)) return location.protocol + u;
    return location.origin + (u[0] === '/' ? '' : '/') + u;
  }

  /*
   * 地址脱敏，用于**显示**（诊断面板 / 日志 / 跨 frame 上报）。
   *
   * 有些网关把密钥放在 query 里（?api_key=xxx），直接打印就等于泄漏。
   * 这里只保留 host + path，query 一律折叠成 "?…"。
   * 注意：这和 exportLog 里的 redact() 不是一回事 —— 那个是导出时的全文正则脱敏，
   * 这个是显示单个 URL 时的粗粒度处理，两者互补。
   */
  function redactUrl(u) {
    const s = String(u == null ? '' : u);
    if (!s) return '(未填写)';
    const q = s.indexOf('?');
    return q < 0 ? s : s.slice(0, q) + '?…';
  }

  /*
   * 带重试的跨域请求（GM_xmlhttpRequest 不受 CORS 限制）。
   *
   * ⚠️ 重试策略是这里唯一需要动脑的地方，因为它直接决定"用户要干等多久"。
   *
   * 原实现是"失败就重试"，看似稳妥，实际最坏情况是：
   *     3 次 × 60s 超时 + 1s + 2s 间隔 = 183 秒
   * 用户盯着「请求中」等三分钟，只会得出"脚本卡死了"的结论。
   *
   * 所以按错误类型区分：
   *   - **超时不重试**。一次 60 秒已经很久了；超时的根因是地址不可达或模型太慢，
   *     重试只会把等待时间乘以 3，不会改变结果。
   *   - **4xx 不重试**。密钥错、地址错、余额不足 —— 重试 100 次也是同样的 4xx。
   *     把错误尽快抛给用户，让他去改配置，才是正确的响应。
   *   - **5xx / 网络抖动重试**。这类才是重试真正能救的场景。
   *
   * @param {object} opts    请求参数（method/url/headers/data/timeout）
   * @param {object} ctrl    { retry, retryOnTimeout, onAttempt }
   *                         onAttempt(i) 在每次尝试**开始前**调用，用于让上层
   *                         把"第几次、从什么时候开始"暴露到诊断里。
   */
  function request(opts, { retry = 1, retryOnTimeout = false, onAttempt = null } = {}) {
    const doOnce = () => new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: opts.method || 'POST',
        url: normalizeUrl(opts.url),
        headers: opts.headers || {},
        data: opts.data,
        timeout: opts.timeout || 30000,
        onload: (res) => resolve(res),
        onerror: (err) => {
          const e = new Error('网络错误: ' + safeJson(err));
          e.kind = 'network';
          reject(e);
        },
        ontimeout: () => {
          const e = new Error('请求超时');
          e.kind = 'timeout';
          reject(e);
        },
      });
    });

    return (async () => {
      let lastErr;
      for (let i = 0; i <= retry; i++) {
        if (onAttempt) { try { onAttempt(i); } catch (e) { /* 观测失败不影响请求 */ } }
        try {
          const res = await doOnce();
          if (res.status >= 200 && res.status < 300) return res;
          lastErr = new Error(`HTTP ${res.status} ${res.responseText?.slice(0, 200) || ''}`);
          lastErr.kind = 'http';
          if (res.status >= 400 && res.status < 500) break;   // 配置问题，重试无意义
        } catch (e) {
          lastErr = e;
          if (e.kind === 'timeout' && !retryOnTimeout) break;
        }
        if (i < retry) await sleep(1000 * (i + 1));
      }
      throw lastErr;
    })();
  }

  function sleep(ms) {
    return new Promise((r) => Timers.after(r, ms));
  }

  /** 元素是否真的可见。checkVisibility 不需要强制同步布局，优先用它 */
  function isVisible(el) {
    if (typeof el.checkVisibility === 'function') {
      try { return el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true }); } catch (e) { /* 落回 rect */ }
    }
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  /** 当前 JS 堆占用（仅 Chromium 提供 performance.memory） */
  function memInfo() {
    const m = performance.memory;
    if (!m) return '不可用（仅 Chromium 内核支持）';
    return `${(m.usedJSHeapSize / 1048576).toFixed(1)}MB / 上限 ${(m.jsHeapSizeLimit / 1048576).toFixed(0)}MB`;
  }

  /* ============================================================
   * 1.7 任务点完成判定
   * ============================================================ */

  /*
   * 判断"这个任务点是否真的完成了"。
   *
   * 超星会在任务点完成后，在页面/目录上打一个完成图标。这是我们唯一可信的外部依据 ——
   * 它由超星自己根据服务器返回的状态渲染，比我们本地推断（"视频播到头了"）可靠得多。
   *
   * 注意不要把"页面上有下一节按钮"当成完成依据，见文件头注释第 4 条。
   */
  const Completeness = {
    selectors() {
      return (CONFIG.completeSelectors || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    },

    /** root 范围内是否出现了完成标记 */
    markFound(root) {
      const scope = root || document;
      for (const sel of this.selectors()) {
        try {
          if (scope.querySelector(sel)) return true;
        } catch (e) { /* 选择器写错了就跳过，不要让整个流程崩掉 */ }
      }
      return false;
    },

    /** 轮询等待完成标记出现 */
    async waitMark(timeout, root) {
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        if (this.markFound(root)) return true;
        await sleep(1000);
      }
      return false;
    },

    /**
     * 诊断用：逐个报告每个选择器命中了几个元素。
     * 超星改版后如果完成标记换了类名，这里会显示一串 ×0，
     * 用户就能照着实际 DOM 把正确的类名补进配置。
     */
    describe(root) {
      const scope = root || document;
      return this.selectors().map((sel) => {
        try {
          return `${sel}×${scope.querySelectorAll(sel).length}`;
        } catch (e) {
          return `${sel}:无效`;
        }
      }).join('  ');
    },
  };

  /* ============================================================
   * 2. 配置读写
   * ============================================================ */

  let CONFIG = loadConfig();

  function loadConfig() {
    let saved = {};
    try { saved = GM_getValue(STORE_KEY, {}) || {}; } catch (e) { saved = {}; }
    const cfg = Object.assign({}, DEFAULT_CONFIG, saved);

    /*
     * v1.4.0 迁移。
     *
     * v1.3.0 只有一个"自定义接口"模式，配置里根本没有 apiMode 字段。
     * 如果直接套默认值 'ai'，老用户填好的自建题库地址会被当成大模型端点去请求，
     * 报错信息还很难懂（"响应里取不到模型输出"）。所以这里做一次判断：
     * 没存过 apiMode、但地址/请求头/请求体明显被改过 → 判为 custom，行为保持不变。
     */
    if (saved.apiMode === undefined) {
      const urlChanged = cfg.apiUrl && cfg.apiUrl !== DEFAULT_CONFIG.apiUrl &&
                         cfg.apiUrl !== LEGACY_PLACEHOLDER_URL;
      const touched = cfg.answerEnabled && (
        urlChanged ||
        (cfg.apiHeaders && cfg.apiHeaders !== DEFAULT_CONFIG.apiHeaders) ||
        (cfg.apiBodyTemplate && cfg.apiBodyTemplate !== DEFAULT_CONFIG.apiBodyTemplate)
      );
      if (touched) {
        // 老版本只有一个"自定义接口"模式，它的地址存在 apiUrl 上。
        // 搬到 apiUrlCustom，并把 AI 模式的地址还原成默认值 ——
        // 否则用户切到 AI 模式时会拿着自建题库的地址去请求大模型，报错还很难懂。
        if (urlChanged) cfg.apiUrlCustom = saved.apiUrl;
        cfg.apiMode = 'custom';
        cfg.apiUrl = DEFAULT_CONFIG.apiUrl;
      } else if (saved.apiUrl === LEGACY_PLACEHOLDER_URL) {
        // 从没配过答题，把面板里那个占位域名换成正常默认值
        cfg.apiUrl = DEFAULT_CONFIG.apiUrl;
      }
    }

    /*
     * v1.4.0：超时从 30s 提到 60s（大模型比题库慢，30s 经常不够）。
     * 但旧配置里存着 30000，Object.assign 会把新默认值盖掉；而面板上又没暴露这一项，
     * 用户想改也改不了。所以老值直接跟着一起升。
     */
    if (saved.apiTimeout === 30000) cfg.apiTimeout = DEFAULT_CONFIG.apiTimeout;

    /*
     * v1.5.0：「页面提示兜底跳转」整个功能已删除 —— 自动下一节改为只看目录上的
     * 完成标记（见第 8 节），不再有"页面提示"这条通路。老配置里残留的键没有任何作用，
     * 顺手清掉，免得面板保存时又原样写回去、下次看配置还以为它在生效。
     */
    delete cfg.domNextFallback;

    return cfg;
  }

  function saveConfig(patch) {
    CONFIG = Object.assign({}, CONFIG, patch);
    try { GM_setValue(STORE_KEY, CONFIG); } catch (e) { warn('配置保存失败', e); }
    return CONFIG;
  }

  let onConfigChanged = null;

  /*
   * 注册配置变更监听。
   *
   * v1.1.0 是在模块顶层无条件注册的，于是**每一个 frame**（包括那些跟脚本毫无关系的
   * 小 iframe）都会挂一个监听器。超星课程页动辄十几个 frame，每次配置写入都要在所有
   * frame 里跑一遍回调。现在改成由 main() 按角色按需调用。
   *
   * 另外这里**不要 log**：一次配置变更会让所有 frame 同时收到回调，
   * 每个 frame 再各写一次日志就是 N² 次存储写入。
   */
  function registerConfigListener() {
    try {
      GM_addValueChangeListener(STORE_KEY, (_k, _old, nv) => {
        CONFIG = Object.assign({}, DEFAULT_CONFIG, nv || {});
        if (typeof onConfigChanged === 'function') onConfigChanged();
      });
    } catch (e) { /* 部分管理器不支持，忽略 */ }
  }

  /* ============================================================
   * 3. 角色识别
   * ============================================================ */

  /**
   * 判断当前 frame 承担什么职责。
   * 只看 URL 和 DOM，不做跨 frame 探测（跨域做不到）。
   *
   * 判定顺序有讲究：**DOM 兜底必须放在 isTop 之前**。
   * 章节测验有可能是新标签页打开的，那时顶层自己就是题目页；
   * 如果先判 isTop，它会返回 'top'，于是只挂个面板、永远不答题 ——
   * 用户看到的就是"切到测验页脚本没反应"。
   */
  function detectRole() {
    const path = location.pathname;

    // 1) 路径优先：最可靠，不受渲染时机影响
    if (/\/ananas\/modules\/video\//i.test(path) || /\/ananas\/modules\/audio\//i.test(path)) {
      return 'video';
    }
    if (/\/ananas\/modules\/(work|exam|homework)\//i.test(path)) {
      return 'work';
    }
    if (/\/exam\//i.test(path) || /\/work\//i.test(path)) {
      return 'work';
    }
    /*
     * ⚠️ read 必须留在这个列表里。
     *
     * 真机实测（2026-09-22）：超星「阅读」任务点的路径是
     *   /ananas/modules/read/indexV2.html
     * 漏掉它 → 落到下面的 DOM 兜底 → 没有题目也没有 video → 返回 unknown
     * → DocModule.start() 从来没被调用过。
     * 表现是"文档模块是死的"：docEnabled 开着也毫无动静，日志里连启动行都没有。
     */
    if (/\/ananas\/modules\/(read|pdf|doc|ppt|book|document)\//i.test(path)) {
      return 'doc';
    }

    // 2) DOM 兜底：URL 不匹配时看页面里有什么（放在 isTop 之前，见上方注释）
    if (document.querySelector('.TiMu, .questionLi, .queBox, .mark_item')) return 'work';
    if (document.querySelector('video')) return 'video';

    // 3) 顶层壳（目录 + iframe），既没有题目也没有视频
    if (isTop) return 'top';
    return 'unknown';
  }

  /** 当前 frame 里题目容器的命中情况，诊断用 */
  function questionProbe() {
    return Q_SELECTORS.container.map((sel) => {
      let n = 0;
      try { n = document.querySelectorAll(sel).length; } catch (e) { n = -1; }
      return `${sel}×${n}`;
    }).join('  ');
  }

  /**
   * 答题观察循环的下次间隔。
   *
   * 抽成纯函数是为了能测：退避写错的后果是两个极端 ——
   * 退太快变成每 1.5 秒全文档查询（回到 v1.0.0 卡顿的老路），
   * 退太慢则用户切到测验页要等很久才有反应。
   *
   * @param {number} cur       当前间隔
   * @param {string} result    上一轮的结果：'ok'（填了题）| 'idle'（没新题）| 'failed'（一题都没填上）
   */
  function watchDelay(cur, result) {
    if (result === 'ok') return 2000;                 // 可能有下一页，很快回头看
    if (result === 'failed') {                        // 接口/解析出问题，别反复打
      return Math.min(Math.max(cur, 15000) * 2, 60000);
    }
    return Math.min(Math.round(cur * 1.5), 8000);     // 没动静就慢慢退，8 秒封顶
  }

  /* ============================================================
   * 3.5 「重新执行」—— 跨 frame
   * ============================================================ */

  /*
   * 面板只挂在顶层，但干活的模块都在子 frame 里。
   *
   * v1.4.0 之前，「重新执行」按钮直接调顶层的 WorkModule.loop() —— 而顶层
   * 根本没有题目容器，点了等于没点。用户手动切到章节测验页、脚本没反应时，
   * 点这个按钮想催一下，结果还是没反应，于是得到"脚本完全坏了"的印象。
   *
   * 现在：顶层写一个时间戳广播出去，各 frame 监听到之后按**自己的角色**重新执行。
   * 顺便重新判一次角色 —— 用户可能是手动切了任务点，frame 内容变了但没重新导航。
   */

  let lastRetryAt = 0;

  /** 面板（顶层）调用：广播 + 本地执行 */
  function requestRetry() {
    const at = Date.now();
    try {
      GM_setValue(EVT_RETRY, { at });
      log('已广播「重新执行」给所有 frame');
    } catch (e) { warn('广播失败', e); }
    // GM_addValueChangeListener 不会在发起方自身触发，所以本地要自己跑一遍
    doRetryLocal(at);
  }

  /** 各 frame 按自己的角色重新执行 */
  function doRetryLocal(at) {
    if (!at || at === lastRetryAt) return;
    lastRetryAt = at;
    breaker.reset();

    /*
     * 「重新执行」是用户**明确要求重来**，所以要把"本任务点已点过提交"的记录
     * 一起清掉 —— 否则那条记录会把脚本永远挡在门外，点了重新执行也没反应。
     * 无条件清、不比对 key：这个动作广播给所有 frame，而顶层 frame 的
     * taskKey() 和干活的那个 iframe 不是同一个，比对 key 永远清不掉。
     */
    WorkModule.clearSubmitLatch();

    const role = detectRole();
    if (role !== CURRENT_ROLE) {
      log(`重新判定角色：${CURRENT_ROLE} → ${role}`);
      CURRENT_ROLE = role;
    }

    switch (role) {
      case 'work':
        WorkModule.restart();
        break;
      case 'doc':
        DocModule.stop();
        DocModule.start();
        break;
      case 'video':
        // 视频不重新绑定（会重复挂监听），只清熔断 + 重设参数
        if (VideoModule.video) VideoModule.applySettings();
        else VideoModule.start();
        break;
      case 'top':
        // 顶层壳：没有要重跑的模块，面板自己会刷新
        break;
      default:
        /*
         * 角色没认出来。用户手动切任务点之后很常见 —— frame 内容变了但没重新导航，
         * 而 detectRole() 只看 URL，认不出新内容。这里按 DOM 现场补一次判断，
         * 否则「重新执行」在这些 frame 里依然等于没点。
         */
        if (document.querySelector('video') && !VideoModule.video) VideoModule.start();
        else if (CONFIG.answerEnabled) WorkModule.restart();
        break;
    }
  }

  function registerRetryListener() {
    try {
      GM_addValueChangeListener(EVT_RETRY, (_k, _o, nv) => {
        if (nv && nv.at) doRetryLocal(nv.at);
      });
    } catch (e) { /* 部分管理器不支持，忽略 */ }
  }

  /* ============================================================
   * 3.6 各 frame 状态上报（诊断用）
   * ============================================================ */

  const FRAME_ID = Math.random().toString(36).slice(2, 8);
  const FRAME_TTL = 300000;   // 5 分钟没更新就从注册表里清掉

  /** 收集本 frame 的当前状态 */
  function selfReport() {
    let frames = 0;
    let questions = 0;
    let video = false;
    let videoJump = '';
    let probe = '';
    let iframeSrcs = [];
    try { frames = document.querySelectorAll('iframe').length; } catch (e) { /* 忽略 */ }
    try { questions = WorkModule.findContainers().length; } catch (e) { /* 忽略 */ }
    try { probe = questionProbe(); } catch (e) { /* 忽略 */ }
    try { video = !!document.querySelector('video'); } catch (e) { /* 忽略 */ }
    try {
      if (VideoModule.video) {
        videoJump = VideoModule.jumped ? 'jumped' : (VideoModule.jumpTried ? 'skipped' : 'probing');
      }
    } catch (e) { /* 忽略 */ }
    /*
     * 把自己 iframe 的 src 也报上去。
     *
     * 这一条是给"子 frame 根本没注入"那种情况准备的：那时候没有任何子 frame 上报，
     * 光看报告只能知道"没注入"，但不知道测验页的地址长什么样，
     * 也就没法判断是 @match 不匹配还是权限问题。有了这份列表，
     * 测验 iframe 的 URL 就摆在眼前了。
     */
    try {
      iframeSrcs = Array.from(document.querySelectorAll('iframe'))
        .slice(0, 12)
        .map((f) => String(f.src || f.getAttribute('src') || '(无 src)').slice(0, 100));
    } catch (e) { iframeSrcs = []; }

    return {
      at: Date.now(),
      role: CURRENT_ROLE,
      top: isTop,
      href: location.href,
      // 答题相关
      answer: !!CONFIG.answerEnabled,
      mode: CONFIG.apiMode === 'custom' ? 'custom' : 'ai',
      questions,
      probe,
      watching: !!WorkModule.watching,   // 观察循环活着（与"是否正在请求"无关）
      busy: !!WorkModule.running,        // 正在跑一轮 loop()（可能卡在 API 请求上）
      pending: !!WorkModule.timer,       // 下一次 tick 已排期
      wait: WorkModule.wait,
      handled: WorkModule.handled.size,
      failStreak: WorkModule.failStreak,
      lastApi: WorkModule.lastApi,
      /*
       * 请求进行中的实时状态：第几次、等了多久、单次超时多少。
       * 只报**进度**，不报地址和密钥 —— 用户已确认配置无误，
       * 配置类信息留在面板的设置区就够了，塞进诊断只是噪音。
       */
      req: WorkModule.req ? {
        attempt: WorkModule.req.attempt,
        total: WorkModule.req.total,
        elapsedMs: Date.now() - (WorkModule.req.attemptStartedAt || WorkModule.req.startedAt),
        timeout: WorkModule.req.timeout,
      } : null,
      // 题旁进度徽标是否开启（影响用户"页面上看不看得到进度"）
      showProgress: !!CONFIG.showProgress,
      // 作答方式：逐题 / 整卷
      answerMode: CONFIG.answerMode === 'batch' ? 'batch' : 'per',
      // 演练模式：开着时页面不会被改动，所以"没答上"是预期内的，不是故障
      dryRun: !!CONFIG.dryRun,
      // 任务点是否已完成 —— 完成时"没在答题"是正常的，不是故障
      taskDone: !!WorkModule.done,
      taskDoneWhy: WorkModule.doneWhy || '',
      /*
       * 题目是否被超星的字体混淆保护（font-cxsecret）。
       * 命中时"没在答题"同样是**正常**的，而且是脚本主动停手 ——
       * 没有这一行，用户和拿到诊断的人都只会把它当成故障来查。
       */
      obfuscated: !!WorkModule.obfuscated,
      // 环境
      video,
      /*
       * 视频「跳到结尾」这一步走到哪了。
       * 三种状态互斥，且都只在视频 frame 里有意义 —— 空字符串表示这个 frame 不管视频。
       *   jumped  已跳到末尾，正在等超星确认（确认不过会自动退回）
       *   skipped 判定为从头播（页面没带进度），不跳
       *   probing 还在观察窗口内
       */
      videoJump,
      frames,
      iframeSrcs,
      timers: Timers.count(),
    };
  }

  /**
   * 把本 frame 的状态写进共享注册表。
   *
   * 一次读改写会跟其它 frame 抢，但每个 frame 只在启动时和收到请求时写，
   * 频率极低，丢了也只会少一行报告，不会影响功能 —— 这个代价换来的可观测性
   * 非常值。写完顺便清理过期项，避免注册表无限增长。
   */
  function reportSelf(quiet) {
    try {
      const cur = GM_getValue(FRAME_KEY, {}) || {};
      const now = Date.now();
      for (const k of Object.keys(cur)) {
        if (!cur[k] || now - (cur[k].at || 0) > FRAME_TTL) delete cur[k];
      }
      const rep = selfReport();
      cur[FRAME_ID] = rep;
      GM_setValue(FRAME_KEY, cur);

      /*
       * 启动时顺手把状态写一行到共享日志里。
       *
       * 日志是所有 frame 混在一起的，所以这一行能回答"这个 iframe 里脚本到底有没有跑"——
       * 用户导出日志时也会带上。收到诊断请求时（quiet）不写，免得每点一次诊断刷 7 行。
       */
      if (!quiet) {
        log(`frame 状态：${rep.role}${rep.top ? '(顶层)' : ''} · 题目×${rep.questions}` +
            ` · ${rep.watching ? '观察中' : '未观察'} · iframe×${rep.frames}`);
      }
    } catch (e) { /* 忽略：上报失败不该影响主流程 */ }
  }

  function registerReportListener() {
    try {
      GM_addValueChangeListener(EVT_REPORT, (_k, _o, nv) => {
        if (nv && nv.at) reportSelf(true);
      });
    } catch (e) { /* 忽略 */ }
  }

  /** 面板调用：请所有 frame 立刻上报一次，然后返回最近的报告列表 */
  async function collectFrameReports() {
    try { GM_setValue(EVT_REPORT, { at: Date.now() }); } catch (e) { /* 忽略 */ }
    // 给各 frame 一点时间响应。900ms 足够 —— 它们只是读一下 DOM 再写一次存储
    await new Promise((r) => Timers.after(r, 900));
    let map = {};
    try { map = GM_getValue(FRAME_KEY, {}) || {}; } catch (e) { map = {}; }
    const now = Date.now();
    return Object.values(map)
      .filter((r) => r && now - (r.at || 0) < 60000)
      .sort((a, b) => (a.top ? -1 : 1) - (b.top ? -1 : 1));
  }

  /**
   * 把各 frame 的上报渲染成可读文本，并给出结论。
   *
   * 纯函数（不碰 DOM 和存储），方便测试 —— 这段的价值全在"结论对不对"上：
   * 结论写错会把用户引到错误的方向，比不给结论更糟。
   */
  function renderFrameReports(reports) {
    const out = [];
    if (!reports || !reports.length) {
      out.push('── 各 frame 状态：没有任何 frame 上报 ──');
      out.push('  ⚠ 脚本没能注入到任何 frame。检查 Tampermonkey 的 iframe / 跨域权限。');
      return out;
    }

    out.push(`── 各 frame 状态（${reports.length} 个）──`);
    for (const r of reports) {
      const tag = (r.top ? 'top' : (r.role || '?')).padEnd(5).slice(0, 5);
      const state = r.taskDone ? '已完成·停止'
        : (r.obfuscated ? '混淆·停止'
          : (r.busy ? '请求中' : (r.watching ? `观察中 ${Math.round((r.wait || 0) / 1000)}s` : '未观察')));
      // 地址截断到 100 字符：诊断的输出就是要被用户整段复制发回来的，
      // 截太短会把 ?workId= / ?chapterId= 这类关键参数切掉，反而没法排查。
      out.push(`[${tag}] 题目×${r.questions}  答题:${r.answer ? '开' : '关'}${r.dryRun ? ' [演练]' : ''}  ${state.padEnd(11)} ${String(r.href || '').slice(0, 100)}`);
      if (r.taskDone) {
        // 明确说出"为什么不答"—— 否则用户会以为脚本坏了
        out.push(`        ✓ 任务点已完成（${r.taskDoneWhy || '未知依据'}），已停止作答`);
      }
      if (r.obfuscated) {
        // 同理：这是脚本**主动**停手，而且是正确的决定。不说清楚就会被当成 bug 来查
        out.push('        🛑 题目被字体混淆（font-cxsecret），已主动停止作答，且不会提交');
      }
      if (r.req) {
        // 请求在飞：给出"第几次、等了多久、还要等多久"。
        // 不打地址和密钥 —— 那是配置问题，不是运行状态，属于另一个排查方向。
        out.push(`        ⏳ 第 ${r.req.attempt}/${r.req.total} 次尝试，本次已 ${Math.round((r.req.elapsedMs || 0) / 1000)}s（单次超时 ${Math.round((r.req.timeout || 0) / 1000)}s）`);
      }
      if (r.lastApi) out.push(`        作答: ${r.lastApi}`);
      if (r.videoJump) {
        // 视频这一步以前完全不可见：用户只能看到"视频停在末尾不动"，
        // 分不清是脚本跳的、还是播完了、还是页面自己卡了。
        const t = r.videoJump === 'jumped' ? '⏭ 视频带进度打开，已跳到结尾（等确认；超星不认会自动退回）'
          : (r.videoJump === 'skipped' ? '视频无进度，按从头播处理'
            : '视频跳结尾：观察窗口中');
        out.push(`        ${t}`);
      }
      if (!r.questions) out.push(`        选择器: ${r.probe}`);
    }

    out.push('');
    const workFrames = reports.filter((r) => r.role === 'work');
    const subs = reports.filter((r) => !r.top);

    if (!workFrames.length && !subs.length) {
      out.push('⚠ 只有顶层一个 frame 上报，子 frame 一个都没有 —— 脚本没有注入到 iframe 里。');
      out.push('  去 Tampermonkey 里确认三件事：');
      out.push('  1) 本脚本处于启用状态；');
      out.push('  2) 设置 → 高级 → 「在 iframe 中运行」相关选项没有被关掉；');
      out.push('  3) 浏览器扩展权限包含「读取和更改所有网站上的数据」。');
      const srcs = reports[0] && reports[0].iframeSrcs;
      if (srcs && srcs.length) {
        out.push('');
        out.push('  顺便把这些 iframe 的地址发我，其中应该就有测验页：');
        srcs.forEach((s, i) => out.push(`   ${i + 1}. ${s}`));
      }
      return out;
    }

    if (!workFrames.length) {
      out.push('⚠ 没有任何 frame 被判为 work 角色 —— 测验页的 URL 没被认出来。');
      out.push('  把上面每行的完整地址发出来，照着补 URL 规则即可。');
      return out;
    }

    const withQ = workFrames.filter((r) => r.questions > 0);
    if (!withQ.length) {
      out.push('⚠ 有 work frame，但题目容器全是 0。按下面顺序判断：');
      out.push('  · 某个 work frame 的「本 frame 内 iframe 数」> 0 → 题目在更深一层的 iframe 里；');
      out.push('  · 都不是 → 题目还没渲染（过一会儿再点诊断），或选择器对不上（F12 找真实类名）。');
      return out;
    }

    /*
     * 字体混淆：题目在、循环也活着，但脚本**故意**不答。
     * 这是正常状态而不是故障 —— 必须放在"循环是不是死了"的判断之前，
     * 否则用户会被引去查一个根本不存在的故障。
     */
    const obf = withQ.filter((r) => r.obfuscated);
    if (obf.length) {
      out.push('🛑 题目被超星的字体混淆保护（font-cxsecret），脚本已主动停止作答。');
      out.push('  抓到的题干和选项是"错字"：DOM 里放的就是错的，靠自定义字体渲染成对的。');
      out.push('  所以送进大模型的文本本身就是错的 —— 答不对与模型、与密钥都无关。');
      out.push('  ⚠ 脚本不会提交这份卷子：交一份错卷比不交更糟（章节测验往往只能提交一次）。');
      out.push('  要恢复作答，得先把文本还原（见 BUGS.md 第 1 条）。');
      return out;
    }

    // 有题但没在观察：先区分"正在请求中"和"循环真的死了"，这两件事的处置完全不同
    const busy = withQ.filter((r) => r.busy);
    const dead = withQ.filter((r) => !r.watching && !r.busy);
    if (dead.length) {
      out.push('⚠ 题目已渲染，但答题模块没在观察，也不在请求中 —— 观察循环确实停了。');
      out.push('  点一次「重新执行」可以让它重新起来；如果还是不行，把这段发我。');
      return out;
    }
    if (busy.length) {
      const r = busy[0];
      const el = r.req ? Math.round((r.req.elapsedMs || 0) / 1000) : null;
      const to = r.req ? Math.round((r.req.timeout || 0) / 1000) : null;

      /*
       * 关键：给出**还要等多久**这个数字。
       * 只说"正在请求"等于没说 —— 用户不知道是 1 秒还是 3 分钟，只能干等或反复点诊断。
       */
      if (el != null && to != null) {
        const left = Math.max(0, to - el);
        out.push(`⏳ 题目已渲染，正在等答题 API 返回 —— 已等 ${el}s，本次最多再等 ${left}s。`);
      } else {
        out.push('⏳ 题目已渲染，正在等答题 API 返回。');
      }
      out.push('  这是正常的等待，不是"没反应"。页面上每道题旁边也会显示「AI 作答中…」。');
      out.push('  若等到超时仍未返回，日志里会出现失败原因。');
      const fail = withQ.find((r2) => r2.failStreak);
      if (fail) out.push(`  已经连续失败 ${fail.failStreak} 次，最后一次：${fail.lastApi || '（无记录）'}`);
      return out;
    }

    out.push('✓ 有 work frame 正在观察，且题目已渲染 —— 抓题这一侧是通的。');
    out.push('  如果仍然没答，问题在请求/回填/提交环节，看日志里"请求答题 API"之后的输出。');
    return out;
  }

  /* ============================================================
   * 4. 视频模块
   * ============================================================ */

  const VideoModule = {
    video: null,
    lastTime: 0,
    stuckCount: 0,
    mediaEnded: false,     // 媒体层面已到达末尾
    notified: false,       // 本地完成确认已通过（整个任务点只走一次）
    confirmTries: 0,       // 完成确认尝试次数，防止反复重试
    timer: null,

    jumpTried: false,      // 「跳到结尾」是否已尝试过（整个任务点只跳一次）
    jumpFrom: 0,           // 跳转前的位置；非 0 表示"当前这个末尾是跳出来的"，用于失败退回
    jumped: false,         // 确实执行过 seek（区别于"探测过但没有进度"）

    /*
     * 顺序编排标记的新鲜度。
     *
     * 一个「视频」标签下可能挂着多个视频任务点（真机 6.1 是两个），顶层会把
     * 「现在该播哪一个」写到 **video 元素**的 __cxSeq 上（见 NextModule.sequenceVideos）。
     * 本 frame 的 VideoModule 读这个标记来决定"我该不该播"。
     *
     * 但它必须有保质期：顶层不在了（脚本被关、页面被替换、顶层 frame 崩了）的时候，
     * 标记会永远留在元素上，于是这个 frame 会**永远**不播 —— 那比不做顺序编排还糟。
     * 过期就当作没有标记，恢复"自己管自己"的默认行为。
     */
    SEQ_TTL_MS: 15000,

    /*
     * 判定"已有播放进度"的观察窗口。
     *
     * 必须短：窗口内如果是从头播，currentTime 最多涨到 min × 窗口/1000（2 倍速下 2 秒 = 4 秒），
     * 达不到默认阈值 5 秒，所以不会把"正常播出来的进度"误判成"页面自带的进度"。
     * 反过来，播放器恢复上次位置是在初始化时一次到位的（几百秒），窗口内必然命中。
     */
    JUMP_WINDOW_MS: 2000,
    JUMP_PROBE_MS: 250,
    /* 硬上限：视频一直加载不出来（duration 永远读不到）时，探测不能永远跑下去 */
    JUMP_HARD_STOP_MS: 30000,

    start() {
      if (!CONFIG.videoEnabled) return;
      this.bind();
    },

    async bind() {
      const v = await waitFor(() => document.querySelector('video'), { timeout: 30000 });
      if (!v) return warn('未找到 video 元素，可能本节不是视频任务点');

      // 新的一节：清掉上一节可能已经熔断的动作，给它一次干净的机会
      breaker.reset();
      // 同理，跳转状态也要重置 —— 否则第二个视频不会再尝试
      this.jumpTried = false;
      this.jumpFrom = 0;
      this.jumped = false;

      this.video = v;
      log('已接管视频:', v.duration ? v.duration.toFixed(1) + 's' : '未知时长');

      this.hardenPlayer();
      this.applySettings();
      this.attachEvents();
      this.startWatchdog();
      this.startJumpProbe();

      /*
       * 这里曾经挂着一个 observe(document.documentElement, {subtree:true}) 的 MutationObserver，
       * 用来检测"播放器被重建"。它是 v1.0.0 卡顿的头号原因：
       *   播放器每秒更新进度条 / 时间文本 / 弹幕 → 几十次 DOM 变更 → 每次都回调
       *   → 回调里又做一次全文档 querySelector('video')。
       * 现在改为在 watchdog（8 秒一次）里用 isConnected 判断，开销可以忽略。
       */
    },

    /** 设置静音 / 倍速 / 起播 */
    applySettings() {
      const v = this.video;
      if (!v) return;
      try {
        v.muted = !!CONFIG.videoMute;
        v.volume = CONFIG.videoMute ? 0 : 1;
        // 倍速：直接改 playbackRate。超星按 playingTime 上报，倍速会让上报时间跑得更快
        const s = Number(CONFIG.videoSpeed) || 1;
        v.playbackRate = s;
        v.defaultPlaybackRate = s;
      } catch (e) { warn('应用播放设置失败', e); }
      this.play();
    },

    /**
     * 读顶层写在这个 video 上的顺序编排标记；没有 / 过期 → 返回 null。
     *
     * 标记由 `NextModule.sequenceVideos()` 写在 **video 元素**上，而不是写在本模块上 ——
     * 这是有意的：一个 frame 里可能不止一个 video，而本模块只认 bind() 抓到的那个，
     * 用模块级字段存状态会让"同一 frame 两个视频"分不开。挂在元素上天然一一对应。
     */
    seqStateOf(v) {
      try {
        const s = v && v.__cxSeq;
        /*
         * 时间戳必须是有效数字 —— 这一条不是多余的防御：
         * 没有它，一个残缺的标记（`at` 缺失 → `Date.now() - undefined` 是 NaN，
         * 而 `NaN > TTL` 恒为 false）会被当成**永不过期**的标记，
         * 于是这个视频被永远按在"等着"，比不做顺序编排还糟。
         */
        if (!s || !isFinite(s.at)) return null;
        if (Date.now() - s.at > this.SEQ_TTL_MS) return null;
        return s;
      } catch (e) { return null; }
    },

    play() {
      const v = this.video;
      if (!v || this.mediaEnded) return;
      if (!v.isConnected) return;      // 元素已脱离文档，操作它没有意义
      if (v.ended) return;

      /*
       * ★ 顺序编排：还没轮到我播。
       *
       * 这一条必须挡在 play() 里，而不是挡在调用点上 —— play() 有 4 个调用点
       * （applySettings / watchdog 的"暂停就恢复" / watchdog 的卡住恢复 / fallbackFromJump），
       * 挨个加判断迟早会漏一个，而漏掉的那一个就会把"等着"的视频顶起来播，
       * 顺序编排当场失效。挡在这里是唯一的收口。
       */
      const sq = this.seqStateOf(v);
      if (sq && !sq.active) return;

      if (!v.paused) return;
      const p = v.play();
      if (p && p.catch) {
        p.catch(() => {
          // 自动播放被拦：先静音再试一次
          try { v.muted = true; v.play().catch(() => {}); } catch (e) {}
        });
      }
    },

    /**
     * 侵入式反暂停加固（默认关闭，见 DEFAULT_CONFIG.aggressiveAntiPause 的说明）。
     *
     * 开启后做两件事：
     *  a) 篡改 document.hidden / visibilityState，让页面的检测逻辑永远认为"可见"
     *  b) 拦掉 visibilitychange / blur 的传播（capture 阶段 stopImmediatePropagation）
     *
     * 这两件事都会改变页面看到的世界，可能让页面自己的清理逻辑永远不执行。
     * 真正的兜底始终是 attachEvents 里的 pause 恢复。
     */
    hardenPlayer() {
      if (!CONFIG.aggressiveAntiPause) return;

      try {
        Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
        Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
        Object.defineProperty(document, 'webkitHidden', { get: () => false, configurable: true });
      } catch (e) { /* 已存在不可配置属性则跳过 */ }

      try { document.hasFocus = () => true; } catch (e) {}

      const kill = (e) => {
        if (!CONFIG.keepPlaying) return;
        e.stopImmediatePropagation();
      };
      document.addEventListener('visibilitychange', kill, true);
      window.addEventListener('blur', kill, true);
      window.addEventListener('pagehide', kill, true);

      // 部分版本用 onblur 赋值，直接覆盖
      try { window.onblur = null; } catch (e) {}

      log('已启用侵入式反暂停（篡改 document.hidden）');
    },

    /** 判断某个 video 是否真的播放到了末尾（比 ended 事件更早、更可靠） */
    reachedEnd(v) {
      if (!v || !isFinite(v.duration) || v.duration <= 0) return false;
      // 留 0.5 秒容差：有些播放器最后一帧不会把 currentTime 精确推到 duration
      return v.currentTime >= v.duration - 0.5;
    },

    /* ------------------------------------------------------------
     * 已有播放进度 → 跳到结尾
     *
     * 要判定的是一件很具体的事：**页面加载时就带着进度**，而不是"播着播着进度变大了"。
     * 两者在某一时刻的 currentTime 完全一样，唯一能区分的是时间：
     * 前者在接管后的极短时间内就出现（播放器一次性恢复上次位置），
     * 后者只能一秒一秒涨上来。所以判定被限制在一个很短的窗口里 —— 这是这个功能的关键。
     *
     * 不在窗口内判定的话，任何一个从头正常播放的视频，播过阈值之后都会被误判成
     * "有进度"，然后被跳到结尾 —— 那等于把正常播放也变成了刷课。
     * ------------------------------------------------------------ */

    /**
     * 观察窗口内反复探，判断"这个视频是不是带着进度打开的"。
     *
     * 计时只在**能读到时长之后**才开始。元数据没加载完（duration 为 NaN）时
     * 探不出任何结论，那段等待不能算进窗口 —— 否则网速一慢，窗口会在
     * "还没法判断"的状态下悄悄走完，功能静默失效，而且看不出来为什么。
     * 另设一个硬上限，避免视频一直加载不出来时探测永远跑下去。
     */
    startJumpProbe() {
      if (!CONFIG.videoJumpToEnd || this.jumpTried) return;
      const hardStop = Date.now() + this.JUMP_HARD_STOP_MS;
      let deadline = 0;

      const probe = () => {
        if (this.jumpTried) return;
        const v = this.video;
        const ready = !!v && v.isConnected && isFinite(v.duration) && v.duration > 0;
        if (ready && !deadline) deadline = Date.now() + this.JUMP_WINDOW_MS;

        if (this.tryJumpToEnd()) return;

        if (Date.now() < hardStop && (!deadline || Date.now() < deadline)) {
          Timers.after(probe, this.JUMP_PROBE_MS);
        } else {
          this.jumpTried = true;   // 窗口走完，判定为"从头播"，不再考虑
        }
      };

      Timers.after(probe, this.JUMP_PROBE_MS);
    },

    /**
     * 探一次。返回 true 表示"这件事已经有结论了，不用再探"。
     */
    tryJumpToEnd() {
      // 幂等：判定过就不再动视频。谁调都一样，不依赖调用方自己守着。
      if (this.jumpTried) return true;

      const v = this.video;
      if (!v || !v.isConnected) return false;
      if (!isFinite(v.duration) || v.duration <= 0) return false;

      // 已经在末尾（或已结束）：没有可跳的，收工
      if (this.reachedEnd(v) || v.ended) { this.jumpTried = true; return true; }

      const at = Number(v.currentTime) || 0;
      const min = Math.max(0, Number(CONFIG.videoJumpMinProgress) || 0);
      if (at < min) return false;    // 没有进度，等窗口内的下一次探

      this.jumpTried = true;
      this.jumpFrom = at;
      const to = Math.max(0, v.duration - 0.5);
      log(`视频已有播放进度 ${at.toFixed(1)}s / ${v.duration.toFixed(1)}s → 尝试跳到结尾（整个任务点只跳一次）`);

      try {
        v.currentTime = to;
        this.jumped = true;
        this.play();
        /*
         * seek 之后 timeupdate 不一定触发（暂停态的 seek 常常不触发），
         * 那样就得白等 watchdog 的 8 秒轮询。这里主动补一次检查，
         * 让完成确认流程立刻接上；watchdog 仍然是最终兜底。
         */
        Timers.after(() => {
          if (this.mediaEnded) return;
          const cur = this.video;
          if (cur && cur.isConnected && this.reachedEnd(cur)) this.onMediaEnd();
        }, 1000);
      } catch (e) {
        // 播放器不支持 seek（有些用自定义控件接管了进度）—— 不是错误，正常继续播就行
        warn('跳到结尾失败，改为正常播放:', (e && e.message) || e);
        this.jumpFrom = 0;
        this.jumped = false;
      }
      return true;
    },

    /**
     * 跳到结尾的尝试没被超星接受 → 退回原位置继续播。
     *
     * 不做这一步的后果很具体：视频停在末尾不动、任务点仍未完成，
     * 用户看到的是"脚本把视频弄停了"，还得自己拖回去。
     * 退回之后至少能正常把缺的进度补上 —— 跳转本来就是个投机动作，
     * 投不中要能干净地退回来。
     *
     * @returns {boolean} 是否真的退了
     */
    fallbackFromJump(why) {
      if (!this.jumpFrom) return false;
      const from = this.jumpFrom;
      this.jumpFrom = 0;             // 清掉，保证只退一次
      this.jumped = false;

      const v = this.video;
      if (!v || !v.isConnected) return false;
      try {
        v.currentTime = from;
      } catch (e) {
        warn('退回原位置失败:', (e && e.message) || e);
        return false;
      }
      log(`跳到结尾${why || '未被超星接受'}，已退回 ${from.toFixed(1)}s 继续播放`);
      this.play();
      return true;
    },

    /**
     * 本任务点里值得跟踪的视频（过滤掉广告之类的小播放器）。
     * 超星有些任务点包含多个分段视频，只播完第一段就跳转会导致任务点仍未完成。
     */
    trackedVideos() {
      return Array.from(document.querySelectorAll('video'))
        .filter((v) => isFinite(v.duration) && v.duration > 5);
    },

    /** 还没播完的视频 */
    pendingVideos() {
      return this.trackedVideos().filter((v) => !(this.reachedEnd(v) || v.ended));
    },

    attachEvents() {
      const v = this.video;
      if (!v || v.__cxBound) return;
      v.__cxBound = true;

      /*
       * 核心兜底：无论谁暂停了视频，都在极短时间内恢复。
       * 必须过熔断 —— 页面若在反复暂停（倍速检测、失焦检测），无脑恢复会和它形成
       * play/pause 拉锯，每次 play 都要重新解码并创建闭包，CPU 打满、内存暴涨。
       */
      v.addEventListener('pause', () => {
        if (this.mediaEnded || !CONFIG.keepPlaying) return;
        if (v.ended) return;
        /*
         * ★ 顺序编排：这个暂停**正是顶层要求的**（"还没轮到你"），别去恢复它。
         *
         * 判断放在熔断器之前是有原因的：熔断器的额度是有限的（15 秒内 8 次），
         * 拿它去拦一个"本来就该保持暂停"的恢复，等于把额度浪费掉 ——
         * 等真正需要恢复播放的时候反而被熔断挡住。
         */
        const sq = this.seqStateOf(v);
        if (sq && !sq.active) return;
        if (!breaker.allow('恢复播放', 8, 15000)) return;
        Timers.after(() => this.play(), 250);
      });

      /*
       * 倍速纠正。**这里是 v1.1.0 内存溢出的头号嫌疑**：
       * 给 playbackRate 赋值本身就会触发 ratechange 事件。如果页面也监听这个事件
       * 并把倍速改回去，就会形成「我们设 2x → 页面改回 1x → 我们又设 2x」的无限循环，
       * 每次循环创建事件对象和闭包，主线程占满、GC 跟不上 → 内存持续上涨。
       * 现在用熔断器限死频率：10 秒内最多纠正 6 次，超过就彻底停手。
       */
      v.addEventListener('ratechange', () => {
        const want = Number(CONFIG.videoSpeed) || 1;
        if (Math.abs(v.playbackRate - want) <= 0.01) return;
        if (!breaker.allow('纠正倍速', 6, 10000)) return;
        try { v.playbackRate = want; } catch (e) {}
      });

      v.addEventListener('ended', () => this.onMediaEnd());

      /*
       * timeupdate 比 ended 更早发现问题：
       *  - 用户（或页面）把进度条拖到末尾时，ended 不一定触发
       *  - 某些播放器在最后一帧就停住，不派发 ended
       * 播放期间约每 250ms 触发一次，这里只做一次数值比较，开销可以忽略。
       */
      v.addEventListener('timeupdate', () => {
        if (this.mediaEnded) return;
        if (this.reachedEnd(v)) this.onMediaEnd();
      });

      v.addEventListener('error', () => warn('视频加载出错:', v.error && v.error.code));
    },

    /**
     * 媒体播完 → 进入**完成确认**流程。
     *
     * 这一步是 v1.3.0 的核心修复。原来的实现是 ended 之后直接等 4 秒就通知顶层跳转，
     * 但那时超星很可能还没把进度上报完、服务器也还没把任务点标记为完成，
     * 结果就是"任务点还显示未完成，页面已经翻到下一节了"。
     *
     * 现在的流程：
     *   1) 等上报沉淀（reportSettleMs）
     *   2) 分清"seek 被页面退回"和"真的还有分段没播完"
     *   3) 校验该任务点所有分段视频都结束了
     *   4) 等页面出现"已完成"标记（requireComplete）
     *   5) 全过了才收工（顺手点一次 iframe 内部的「下一节」）
     * 任何一环没过就不跳转，并说明原因。
     */
    async onMediaEnd() {
      if (this.mediaEnded) return;
      this.mediaEnded = true;

      /*
       * ★ 顺序编排：本标签下还有别的视频任务点，现在轮不到"整个任务点完成"。
       *
       * 不加这一条会出两件具体的错（真机 6.1 那种「一个标签两个视频」的形状）：
       *
       *  1) 第一个视频播完就走进完成确认，于是**先白等** reportSettleMs + completeWaitMs
       *     （默认 8s + 25s），等不到标记再退回、放开、重试 —— 最多 3 轮。
       *     这段时间里顶层还没轮到第二个视频，整个任务点净耗一分半钟。
       *  2) 若用户把「完成校验」关掉（requireComplete=false），这里会直接
       *     `notified = true` 并尝试点 iframe 里的「下一节」—— 那是**真的会跳走**，
       *     第二个视频任务点就废了（脚本只往前走、不往回切）。
       *
       * 交给顶层是有依据的：只有顶层同时看得见标签下的**全部**视频
       * （本 frame 的 pendingVideos() 只数自己这一层），"什么时候才算整个任务点做完"
       * 这件事本 frame 判不了。
       */
      const sq = this.seqStateOf(this.video);
      if (sq && !sq.isLast) {
        log(`本标签下共 ${sq.total} 个视频任务点，我是第 ${sq.index + 1} 个（已播完），` +
            '本地完成确认交给顶层编排');
        return;
      }

      if (this.confirmTries >= 3) {
        warn('完成确认已尝试 3 次仍未通过，停止本地确认。请检查「完成标记选择器」是否正确');
        return;
      }
      this.confirmTries++;

      log('视频已到达末尾，开始确认任务点是否真正完成…');

      // 1) 给超星播放器时间把最后一次进度上报发出去
      await sleep(CONFIG.reportSettleMs);

      // 期间可能已经切走了，检查一下
      if (!this.video || !this.video.isConnected) return log('播放器已卸载，确认流程结束');

      /*
       * 2) 先排除一种**假**的"还有分段没播完"。
       *
       * 未完成的任务点禁止拖拽（见 BUGS.md 第 6 条），所以"跳到结尾"经常不被接受：
       * 位置会被页面退回去。这时 pendingVideos() 会把**刚跳的那个视频自己**算成
       * "没播完"，于是日志写出自相矛盾的话 —— 真机 2026-09-22 22:00 的原文：
       *
       *   ⚠ 该任务点还有 1 个视频未播放完（本页共跟踪 1 个），取消跳转，继续播放
       *
       * "1 个里还有 1 个没播完"其实只有一种可能：**它自己**就是那个没播完的 ——
       * 也就是说这不是"分段"，而是 seek 被退回。走错分支还会把原因说错，
       * 让排查的人去找根本不存在的"第二个分段"。
       */
      const self = this.video;
      const seekRolledBack = this.jumped && !!self && self.isConnected &&
                             !this.reachedEnd(self) && !self.ended;
      if (seekRolledBack) {
        warn('跳到结尾没被超星接受（位置已被页面退回），取消跳转，继续播放');
        this.fallbackFromJump();
        this.mediaEnded = false;
        return;
      }

      // 3) 多分段任务点：还有分段没播完就不能跳
      const pending = this.pendingVideos();
      if (pending.length) {
        warn(`该任务点还有 ${pending.length} 个视频未播放完（本页共跟踪 ${this.trackedVideos().length} 个），取消跳转，继续播放`);
        // 这个末尾若是跳出来的，退回继续播 —— 停在末尾的话 play() 推不动它
        this.fallbackFromJump('但本任务点还有分段没播完');
        this.mediaEnded = false;
        this.play();
        return;
      }

      // 4) 等超星自己把任务点标记为完成
      if (CONFIG.requireComplete) {
        const ok = await Completeness.waitMark(CONFIG.completeWaitMs);
        if (!ok) {
          warn(`等待「任务点已完成」标记超时（${CONFIG.completeWaitMs}ms），本地确认不通过。` +
               '可能原因：进度还没上报完、该任务点有多个子任务、或「完成标记选择器」与实际页面不符。' +
               '跳不跳由顶层看目录标记决定，这条只影响本 frame 收不收工');
          /*
           * 如果这个末尾是"跳"过来的，超星没认就说明 seek 没能补上缺的进度。
           * 退回原位置继续播 —— 否则视频会僵在末尾，任务点永远完不成。
           */
          this.fallbackFromJump();
          this.mediaEnded = false;   // 放开，允许后续再检测一次
          return;
        }
        log('已确认任务点标记为完成 ✓');
      } else {
        log('（已关闭完成校验，仅按播放进度判断）');
      }

      // 5) 确认通过
      if (this.notified) return;
      this.notified = true;
      this.jumpFrom = 0;   // 这一跳被接受了，不需要再退回

      if (this.timer) Timers.clear(this.timer);

      if (!CONFIG.autoNext) {
        log('任务点已完成（未开启自动下一节，请手动切换）');
        return;
      }
      this.tryClickNextInFrame();
    },

    /**
     * 卡住检测 + 播放器重建检测。8 秒一次，代价可忽略。
     * 原来"检测播放器重建"是靠全文档 MutationObserver 做的，见 bind() 里的说明。
     */
    startWatchdog() {
      if (this.timer) Timers.clear(this.timer);
      this.timer = Timers.every(() => {
        let v = this.video;

        // 播放器被重建：video 元素脱离文档 → 重新找一次并重新接管
        if (!v || !v.isConnected) {
          const cur = document.querySelector('video');
          if (cur && cur !== v) {
            log('播放器已重建，重新接管');
            this.video = cur;
            this.attachEvents();
            this.applySettings();
            v = cur;
          } else {
            // 找不到新元素：旧的那个已经游离，放弃它，别继续对它做任何操作
            this.video = null;
            return;
          }
        }

        if (this.mediaEnded) return;

        /*
         * ★ 顺序编排：还没轮到我播，"不动"是**正确状态**，不是卡住。
         *
         * 不加这一条的话，下面那段"卡住恢复"会每 32 秒把 currentTime 往前推 0.5 秒 ——
         * 等着的视频被慢慢推着走，看着像在播、其实没有上报，纯粹是脏状态。
         * 顺手把 stuckCount 清零：等轮到它播的时候，计数从干净的状态重新开始。
         */
        const sq = this.seqStateOf(v);
        if (sq && !sq.active) { this.stuckCount = 0; return; }

        if (v.paused) return this.play();

        // 兜底：万一 timeupdate 没覆盖到（比如播放器被替换），这里再查一次
        if (this.reachedEnd(v)) return this.onMediaEnd();

        if (Math.abs(v.currentTime - this.lastTime) < 0.5) {
          this.stuckCount++;
          if (this.stuckCount >= 4 && breaker.allow('恢复卡住', 5, 60000)) {
            warn('播放疑似卡住，尝试恢复');
            this.stuckCount = 0;
            try { v.currentTime = v.currentTime + 0.5; } catch (e) {}
            this.play();
          }
        } else {
          this.stuckCount = 0;
        }
        this.lastTime = v.currentTime;
      }, 8000);
    },

    /** 有些章节的"下一节"按钮就在 iframe 内部，确认完成后就地尝试一次 */
    tryClickNextInFrame() {
      const el = findNextButton(document);
      if (el) {
        log('iframe 内找到下一节按钮，点击');
        Timers.after(() => el.click(), CONFIG.nextDelay);
      }
    },
  };

  /**
   * 在给定 document 中找"下一节/下一章"按钮。
   *
   * 文案收窄过：去掉了「下一个」「继续学习」—— 前者会误匹配分页控件，
   * 后者常常是常驻的引导按钮。这里只在**已经确认任务点完成**之后才会被调用。
   */
  function findNextButton(root) {
    const texts = ['下一节', '下一章', '下一课'];
    const nodes = root.querySelectorAll('a, button, div[class*="next"], span[class*="next"], .jb_btn');
    /*
     * **必须先挑可见的那个。**
     *
     * 超星页面上同时存在三个「下一节」按钮（真机实测，v1.5.1 修）：
     *   A.jb_btn.jb_btn_92.fr.fs14.nextChapter   藏在 .popBottom 里，不可见
     *   A.bluebtn02.prebutton.nextChapter        藏在 .marTop30 里，不可见
     *   DIV.jb_btn.jb_btn_92.prev_next.next…     **页面上真正可见、可点的那个**
     *
     * 原来直接返回文档序里的第一个 —— 正好是隐藏的那个。隐藏元素的 onclick 用
     * `.click()` 也**能**触发，但那是另一条代码路径（`closeDeleteWindow()` 之类），
     * 依赖弹窗状态，不该被当成正常的"下一节"。全都不可见时才退回它。
     */
    let hidden = null;
    for (const n of nodes) {
      const t = (n.textContent || '').trim();
      if (!t || t.length > 12) continue;
      if (!texts.some((k) => t.includes(k))) continue;
      const off = n.classList.contains('disabled') || n.getAttribute('aria-disabled') === 'true';
      if (isVisible(n) && !off) return n;
      if (!hidden) hidden = n;
    }
    return hidden;
  }

  /* ============================================================
   * 5. 答题模块
   * ============================================================ */

  /* ==== AI 答题纯函数 BEGIN（bench/ai-answer-test.js 会原样提取这一段来测）====
   *
   * 这一整段刻意写成**无副作用、不依赖 CONFIG / DOM 的纯函数**，
   * 因为"模型返回的文本 → 可回填的答案"这一步是整个 AI 答题链路里最容易出错、
   * 又最难在真实页面上复现的部分（要等一次真实的 API 往返）。
   * 抽成纯函数后就能用固定输入穷举各种畸形响应。
   */

  /**
   * 把用户填的「API 地址」补成完整的 chat/completions 端点。
   *
   * 大多数 OpenAI 兼容服务（OpenAI / DeepSeek / 通义 compatible-mode / 各类中转站）
   * 都是「base + /chat/completions」的结构，让用户自己拼太容易拼错，所以这里自动补。
   * 兼容三种填法：
   *   https://api.openai.com/v1            → .../v1/chat/completions
   *   https://api.deepseek.com             → .../v1/chat/completions
   *   https://x.com/v1/chat/completions    → 原样返回（已经是完整端点）
   * 路径不规则的网关，勾面板上的「地址已是完整路径」即可跳过补全。
   */
  function resolveChatEndpoint(u, isFull) {
    const url = String(u == null ? '' : u).trim().replace(/\/+$/, '');
    if (!url) return '';
    if (isFull || /\/chat\/completions$/i.test(url)) return url;
    if (/\/v\d+$/i.test(url)) return url + '/chat/completions';
    return url + '/v1/chat/completions';
  }

  /** 从文本里截出第一段括号配平的 [...] 或 {...}，会跳过字符串字面量里的括号 */
  function sliceBalanced(s, open, close) {
    const start = String(s).indexOf(open);
    if (start < 0) return '';
    let depth = 0;
    let inStr = false;
    let quote = '';
    let esc = false;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (inStr) { if (ch === quote) inStr = false; continue; }
      if (ch === '"' || ch === "'") { inStr = true; quote = ch; continue; }
      if (ch === open) depth++;
      else if (ch === close) { depth--; if (!depth) return s.slice(start, i + 1); }
    }
    return '';
  }

  function tryJson(s) {
    try { return JSON.parse(s); } catch (e) { return null; }
  }

  /** 把任意形态的值（字符串/数组/嵌套对象）压成一段文本 */
  function textOf(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v.trim();
    if (Array.isArray(v)) return v.map(textOf).filter(Boolean).join('');
    if (typeof v === 'object') return textOf(v.text ?? v.content ?? v.value ?? '');
    return '';
  }

  /*
   * 模型输出在响应 JSON 里的位置。
   * 按"常见 → 冷门"排序，逐条试。多写几条是因为中转站/自建网关会把 OpenAI 的
   * 结构改得五花八门（有的直接返回 {content:"..."}，有的包一层 {data:{...}}）。
   */
  const MODEL_TEXT_PATHS = [
    'choices.0.message.content',     // OpenAI / DeepSeek / 通义 / 绝大多数兼容实现
    'choices.0.delta.content',       // 万一流式响应没关干净
    'choices.0.text',                // 老 completion 接口
    'data.choices.0.message.content',
    'data.choices.0.text',
    'message.content',
    'output_text',                   // OpenAI Responses API
    'data.output_text',
    'content',
    'data.content',
    'data.result',
    'result',
    'answer',
  ];

  function pickModelText(json) {
    for (const p of MODEL_TEXT_PATHS) {
      const s = textOf(deepGet(json, p));
      if (s) return s;
    }
    return '';
  }

  /** 把模型给的 answer 归一成字符串（可能是数组 ["A","B"]、数字、或嵌套对象） */
  function normalizeAnswerValue(v) {
    if (v == null) return '';
    if (Array.isArray(v)) return v.map(normalizeAnswerValue).filter(Boolean).join('');
    if (typeof v === 'object') return normalizeAnswerValue(v.answer ?? v.text ?? v.value ?? v.content ?? '');
    return String(v).trim();
  }

  /**
   * 模型偶尔不按约定给字母，而是直接给选项正文（"键盘"），这里回查一次选项表。
   * 只在选项数量少、文本有区分度时才敢匹配，否则容易误判。
   */
  function matchOptionByText(options, text) {
    const t = String(text == null ? '' : text).replace(/\s+/g, '').toLowerCase();
    if (!t || !Array.isArray(options) || !options.length) return '';
    for (const o of options) {
      if (String(o.text || '').replace(/\s+/g, '').toLowerCase() === t) return o.key;
    }
    if (t.length < 2) return '';
    for (const o of options) {
      const ot = String(o.text || '').replace(/\s+/g, '').toLowerCase();
      if (ot.length >= 2 && (t.includes(ot) || ot.includes(t))) return o.key;
    }
    return '';
  }

  /**
   * 按题型把答案裁成 fillOne 能直接回填的形式。
   *
   * 为什么需要这一刀：模型经常输出 "A. 键盘" / "答案是 B" / "AB（因为…）"。
   * fillOne 是靠扫 [A-Z] 提取选项字母的，多选时正文里夹带的英文会被一起当成选项，
   * 结果点错一串。所以先把答案裁干净。
   */
  function cleanAnswerFor(q, raw) {
    const s = normalizeAnswerValue(raw);
    if (!s) return '';
    const type = q && q.type;
    const opts = (q && q.options) || [];

    if (type === 'multi') {
      /*
       * 两种情况分开处理：
       *   "ABD" / "A、B、D" / "A和B" —— 整串就是答案，全取
       *   "ABD（因为 A 项正确）"      —— 只取开头那段，丢掉后面的解释
       * 不做这个区分的话，多选答案里夹带的解释文字会被当成选项，点错一串。
       */
      const whole = /^[\sA-Za-z,，、;；/和与+]+$/.test(s);
      const seg = whole ? s : (s.match(/^[\sA-Za-z,，、;；/]*/) || [''])[0];
      const letters = seg.toUpperCase().match(/[A-Z]/g) || [];
      if (letters.length) return letters.join('');
    } else if (type === 'single') {
      const all = s.match(/[A-Za-z]/g) || [];
      // 整串只有一个字母 → 几乎可以肯定是选项字母
      if (all.length === 1) return all[0].toUpperCase();
      // 否则只认"字母 + 分隔符"开头这种明确写法（"A. xxx" / "A、xxx"）
      const head = s.match(/^\s*([A-Za-z])\s*[.、．)）:：,，]/);
      if (head) return head[1].toUpperCase();
    } else if (type === 'judge') {
      if (/^\s*(对|正确|是|T|TRUE|√|Y|1)/i.test(s)) return '对';
      if (/^\s*(错|错误|否|F|FALSE|×|X|N|0)/i.test(s)) return '错';
    } else {
      return s;   // 填空 / 简答：原文返回，交给 fillOne 按 | 拆分
    }

    // 没提出字母 —— 可能模型直接给了选项正文，回查一次
    return matchOptionByText(opts, s) || s;
  }

  /** 把解析出来的原始结构摊平成 byId / byIndex 两张表 */
  function absorbAnswerData(data, byId, byIndex) {
    if (Array.isArray(data)) {
      data.forEach((item, i) => {
        if (item == null) return;
        if (typeof item === 'object' && !Array.isArray(item)) {
          const id = String(item.id ?? item.qid ?? item.questionId ?? '');
          const ans = item.answer ?? item.answerText ?? item.value ?? item.result ?? item.content ?? item.text;
          if (id) byId[id] = ans;
          else byIndex[i] = ans;      // 没给 id 就按顺序对齐
        } else {
          byIndex[i] = item;
        }
      });
      return;
    }
    if (data && typeof data === 'object') {
      // {"answers":[...]} / {"data":[...]} 这类再往里钻一层
      for (const k of ['answers', 'data', 'result', 'list', 'results', 'items']) {
        if (Array.isArray(data[k])) return absorbAnswerData(data[k], byId, byIndex);
      }
      // 纯映射 {"q1":"A","q2":"B"}
      for (const [k, v] of Object.entries(data)) {
        if (v == null) continue;
        byId[k] = (typeof v === 'object') ? (v.answer ?? v.value ?? v.text ?? v) : v;
      }
    }
  }

  /**
   * 把模型返回的**文本**解析成 { byId, byIndex }。
   * 三层容错，逐层降级：
   *   1) 整段就是 JSON —— 提示词约束的就是这个，正常情况走这层
   *   2) 文本里夹着 JSON —— 模型加了"好的，答案如下："前缀或 ```json 围栏
   *   3) 连 JSON 都没有 —— 退化成按行扫 "q1: A" / "1. A"
   */
  function parseAnswersFromText(text, questions) {
    const byId = {};
    const byIndex = [];
    const raw = String(text == null ? '' : text).trim();
    if (!raw) return { byId, byIndex };

    const cleaned = raw.replace(/^```[a-zA-Z]*\s*/, '').replace(/```\s*$/, '').trim();

    let data = tryJson(cleaned);
    if (data == null) {
      const seg = sliceBalanced(cleaned, '[', ']') || sliceBalanced(cleaned, '{', '}');
      if (seg) data = tryJson(seg);
    }
    if (data != null) {
      absorbAnswerData(data, byId, byIndex);
      if (Object.keys(byId).length || byIndex.length) return { byId, byIndex };
    }

    // 第 3 层：按行扫。行首是 q1 / 1 / 第1题 都认
    const lineRe = /(?:^|\n)\s*(?:第)?\s*(?:q|Q)?(\d+)\s*(?:题)?\s*[.、:：)）\]]\s*([^\n]+)/g;
    let m;
    while ((m = lineRe.exec(cleaned))) {
      const val = m[2].trim();
      if (val) byId['q' + m[1]] = val;
    }
    return { byId, byIndex };
  }

  /** 取某道题的原始答案：先按 id，再按 "1" / "q1" 这类变体，最后按顺序 */
  function pickAnswerFor(byId, byIndex, q, i) {
    const keys = [q.id, String(i + 1), 'q' + (i + 1), 'Q' + (i + 1)];
    for (const k of keys) {
      const v = byId[k];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    const v2 = byIndex[i];
    if (v2 !== undefined && v2 !== null && v2 !== '') return v2;
    return '';
  }

  /*
   * 单题兜底：整段回复就是一个裸答案。
   *
   * 逐题作答时，模型经常只回 "A" / "答案是 B" / "选 C" —— 既没有 JSON，
   * 也没有 "q1:" 前缀，上面三层解析全都取不到。但这时候上下文里**只有一道题**，
   * 整段文本就是答案的概率极高，白白丢掉太可惜。
   *
   * 判据刻意保守：宁可判失败（用户能看见"未作答"并手动补），也绝不能填错 ——
   * 章节测验通常只允许提交一次，填错比留空更糟。
   *
   * 特别是多字母答案**要求升序**："ABD" 是答案，"DAB"/"bad" 更可能是别的词。
   * 代价是 "DAB" 这种非规范写法会被判失败，但那会显示成"未作答"，
   * 用户一眼能看见；而误填是静默的。
   */
  function bareAnswerOf(text, q) {
    let s = String(text == null ? '' : text).trim();
    if (!s || s.length > 40) return '';
    if (/[\n{}[\]"']/.test(s)) return '';      // 带结构就交给上面三层，别抢

    /*
     * "好的，答案是 A。" / "应选 ABD" —— 这类带前言的回复在逐题模式下最常见。
     * 从"答案/选项/选"后面把答案抠出来，比按"整段就是答案"处理准得多。
     */
    const tail = s.match(/(?:答案|正确答案|选项|应选|选)\s*(?:是|为|[:：])?\s*([A-Za-z]{1,4})\s*[。．.!！]?\s*$/);
    if (tail) {
      s = tail[1];
    } else {
      // 没有前言：按"整段就是答案"处理，剥掉前缀和句末标点
      s = s.replace(/^(?:答案|正确答案|选项|应选|选|答)\s*(?:是|为|[:：])?\s*/, '').trim();
      s = s.replace(/[。．.!！\s]+$/, '').trim();
    }
    if (!s || s.length > 20) return '';

    const keys = ((q && q.options) || []).map((o) => String(o.key).toUpperCase()).filter(Boolean);
    if (keys.length) {
      // 先把字母之间的分隔符去掉，"A、B、D" 和 "ABD" 是同一个答案
      const compact = s.replace(/[\s、,，;；/和与+]+/g, '');
      const chars = [...compact.toUpperCase()];
      if (chars.length && chars.length <= 4 && chars.every((c) => keys.includes(c))) {
        if (chars.length === 1) return chars[0];
        /*
         * 多选必须是"升序且不重复"。
         * 只查去重是不够的 —— "DAB"、"BAD" 字母也不重复，但它们是词不是答案。
         * 反过来说，"ABD" 是标准写法；"DAB" 会被判失败显示成"未作答"，
         * 用户看得见并手动补，比静默填错安全。
         */
        const sorted = [...chars].sort();
        if (sorted.join('') === chars.join('')) return chars.join('');
      }
    }

    if (/^(?:对|错|正确|错误|是|否|T|F|TRUE|FALSE|√|×|✓|✗)$/i.test(s)) return s;

    // 填空 / 简答：短、且不像一句话
    if ((q && (q.type === 'blank' || q.type === 'essay')) &&
        s.length <= 20 && !/[，,；;：:]/.test(s)) return s;

    return '';
  }

  /** 一步到位：模型返回的文本 + 题目列表 → { q1: 'A', q2: 'ABD' } */
  function resolveAnswers(text, questions) {
    const { byId, byIndex } = parseAnswersFromText(text, questions);
    const out = {};
    const list = questions || [];
    list.forEach((q, i) => {
      let a = cleanAnswerFor(q, pickAnswerFor(byId, byIndex, q, i));
      /*
       * 只有一道题时启用裸答案兜底。
       * 为什么限定"只有一道题"：题目一多，整段文本就不可能是一个裸答案，
       * 此时开启兜底只会增加误判面。
       */
      if (!a && list.length === 1) a = cleanAnswerFor(q, bareAnswerOf(text, q));
      out[q.id] = a;
    });
    return out;
  }

  /* ==== AI 答题纯函数 END ==== */

  const Q_SELECTORS = {
    // 题目容器（按优先级）
    container: ['.TiMu', '.questionLi', '.queBox', '.mark_item', '.subject_describe'],
    // 题干
    stem: ['.Zy_TItle', '.mark_name', '.qtContent', '.TiMu .clearfix', '.subject_describe'],
    // 选项行
    option: ['.Zy_ulTop > li', '.Zy_ulTop .clearfix', '.answerBg', '.optionItem', '.clearfix > label'],
    // 选项里的字母 / 文本
    optionLabel: ['.num_option', '.fl', 'i'],
    optionText: ['.answer_p', 'a', 'label', 'span'],
    // 填空
    blank: ['textarea', 'input[type="text"]', 'div[contenteditable="true"]'],
    // 提交
    submit: ['#submitBtn', '.completeBtn', '.Btn_blue_1', '.subBtn', 'button[type="submit"]'],
    /*
     * 提交二次确认弹窗的"确定"按钮。
     * layui 是超星弹层用的库，它的确定按钮固定是 `.layui-layer-btn0` —— 最可靠的一条，
     * 其余几条是改版 / 自研弹层的兜底。
     */
    dialogConfirm: ['.layui-layer-btn0', '.layui-layer-btn a', '.jw_btn_confirm', '.popup_content .btn'],
    /*
     * 弹层容器。
     * **按文案兜底找按钮时，只允许在这些容器内部找** —— 整页搜「提交」会命中
     * 提交按钮本身，于是脚本会疯狂点提交、反复弹确认框，比不点还糟。
     *
     * 前四条是已知的（layui 和超星自研）。后面几条是**通配** —— 超星前端会改版，
     * 弹层类名从 `.layui-layer` 换成别的名字时，精确匹配会全部落空，
     * 而症状是"弹窗明明在屏幕上，脚本却说没找到"。通配只是扩大搜索面：
     * 真正的判据是"容器里有没有确定类文案的按钮"，类名宽一点不会把普通按钮卷进来。
     */
    dialogLayer: [
      '.layui-layer', '.layui-layer-dialog', '.popup_content', '#popok',
      '[class*="layer"]', '[class*="popup"]', '[class*="dialog"]',
      '[class*="modal"]', '[class*="confirm"]', '[class*="tips"]',
    ],
    // 弹层里可能充当按钮的元素
    dialogBtn: ['a', 'button', 'input[type="button"]', 'input[type="submit"]', '[class*="btn"]'],
  };

  /** 题目容器合并成一个选择器，用于"这个文档里有没有题"的快速判断 */
  const QUESTION_ANY = Q_SELECTORS.container.join(',');

  /** 弹层里的按钮元素，合并成一个选择器 */
  const DIALOG_BTN_ANY = Q_SELECTORS.dialogBtn.join(',');

  /*
   * 弹层类名的关键词。
   * 给"整页兜底"判断一个按钮是不是长在弹层里用（见 inPopupLike）。
   */
  const POPUP_HINT = /layer|popup|dialog|modal|confirm|alert|notice|tips?|mask/i;

  /**
   * 这个元素是不是处在一个"看起来像弹层"的容器里（往上找 8 层，任一层的 class 命中关键词）。
   *
   * 存在的理由：整页找"确定"按钮这件事本身很危险 —— 页面上随便一个确定按钮被点到
   * 都可能出事。加上这道判断之后，只有"长在弹层里"的按钮才敢碰。
   */
  function inPopupLike(el) {
    let n = el;
    for (let i = 0; i < 8 && n; i++) {
      if (POPUP_HINT.test(String(n.className || ''))) return true;
      n = n.parentElement;
    }
    return false;
  }

  /**
   * 列出当前文档里"看起来像弹层"的元素 —— 给面板的「弹窗诊断」用。
   *
   * 存在的理由：提交确认弹窗点不掉，只有两种可能 —— **没找到它**，或者
   * **找到了但点了没用**。这两者的修法完全不同，而"没找到"在页面上完全不可见：
   * 用户只看到弹窗杵在那儿，脚本日志里可能一个字都没有。
   *
   * 这个函数把弹层的真实 DOM 摊开（类名 / 按钮文案 / 脚本会怎么处理它），
   * 复制回来就能直接改选择器，不用再来回猜。
   *
   * 只读，不点任何东西。
   */
  function describePopups() {
    const out = [];
    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(
        '[class*="layer"],[class*="popup"],[class*="dialog"],[class*="modal"],' +
        '[class*="confirm"],[class*="tips"],[id*="popok"]'
      ));
    } catch (e) { nodes = []; }

    const rows = [];
    const seen = new Set();
    for (const n of nodes.slice(0, 300)) {
      let btns = [];
      try {
        btns = Array.from(n.querySelectorAll(DIALOG_BTN_ANY)).filter((b) => isVisible(b) && buttonText(b));
      } catch (e) { continue; }
      if (!btns.length) continue;
      const key = String(n.className) + '|' + btns.map(buttonText).join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push({ n, btns });
    }

    if (!rows.length) {
      out.push('  没找到"看起来像弹层且带按钮"的元素。');
      out.push('  · 屏幕上明明有弹窗 → 它的类名不含 layer/popup/dialog/modal/confirm/tips。');
      out.push('    F12 选中弹窗，把最外层容器的 class 和按钮的 HTML 复制出来。');
      out.push('  · 弹窗在跨域 iframe 里 → 脚本够不到，只能手动点。');
      return out;
    }

    out.push(`  发现 ${rows.length} 个疑似弹层（最多列 10 个）：`);
    for (const { n, btns } of rows.slice(0, 10)) {
      const cls = String(n.className || '(无)').slice(0, 80);
      out.push(`  · <${String(n.tagName).toLowerCase()} class="${cls}">${isVisible(n) ? '' : ' [不可见]'}`);
      for (const b of btns.slice(0, 4)) {
        const t = buttonText(b);
        const verdict = isDialogCancel(t) ? '取消类 → 跳过'
          : (isDialogConfirm(t) ? '确定类 → **会点它**' : '不识别（文案不符合约定）');
        out.push(`      <${String(b.tagName).toLowerCase()} class="${String(b.className || '(无)').slice(0, 50)}"> "${t}" → ${verdict}`);
      }
    }
    return out;
  }

  /*
   * 弹窗按钮的文案判定。
   *
   * **必须先判取消、再判确定**，顺序不能反 ——「取消提交」里含「提交」，
   * 反过来判就会把「取消提交」当成确定按钮点下去，结果是用户刚填好的卷子
   * **被脚本主动取消了提交**。这是这两个函数唯一不能出错的地方。
   */
  const DIALOG_CANCEL_TEXTS = ['取消', '关闭', '返回', '放弃', '暂不', '不提交', '再看看', '再想想'];
  const DIALOG_CONFIRM_TEXTS = ['确定', '确认', '提交', '继续'];

  /** 按钮上的可见文字（textContent / value / title 都算） */
  function buttonText(el) {
    if (!el) return '';
    const raw = el.textContent || el.value || (el.getAttribute && el.getAttribute('title')) || '';
    return String(raw).replace(/\s+/g, '');
  }

  function isDialogCancel(text) {
    const t = String(text == null ? '' : text).replace(/\s+/g, '');
    return DIALOG_CANCEL_TEXTS.some((k) => t.includes(k));
  }

  /**
   * 这段文字像不像弹窗里的"确定"按钮。
   *
   * 长度上限 8、且不含标点 —— 这两条是为了把**弹层正文**排除掉：
   * 文案兜底会在弹层里遍历元素，而正文容器常常也带 btn 类名。
   */
  function isDialogConfirm(text) {
    const t = String(text == null ? '' : text).replace(/\s+/g, '');
    if (!t || t.length > 8) return false;
    if (/[？?，,。.！!：:；;]/.test(t)) return false;
    if (isDialogCancel(t)) return false;
    return DIALOG_CONFIRM_TEXTS.some((k) => t.includes(k));
  }

  /*
   * "这道题已经填过了"的 DOM 标记。
   *
   * 比 FRAME_MARK 更硬的第二道防线：即使因为加载时序问题，两个 frame 都决定处理
   * 同一批题，这个标记也能保证**每个选项只会被点一次**。
   * 为什么这件事很严重：多选题的选项是 checkbox，点两次等于取消勾选 ——
   * 不是"重复劳动"，是直接把答案改错。
   */
  const FILLED_MARK = 'data-cx-filled';

  /*
   * 脚本在文档上打的标记。
   *
   * 每个注入成功的 frame 都会在自己的 documentElement 上打这个属性。
   * 作用是让 questionRoot() 能判断"那一层 iframe 里有没有自己的脚本实例" ——
   * 有的话就不该替它干活，否则同一个 iframe 树里会有两个 frame 处理同一批题。
   */
  const FRAME_MARK = 'data-cx-auto-frame';

  /** 本 frame 是否已被脚本接管 */
  function markedByScript(doc) {
    try {
      return !!(doc && doc.documentElement && doc.documentElement.hasAttribute(FRAME_MARK));
    } catch (e) { return false; }
  }

  /*
   * 题目到底在哪个文档里。
   *
   * 超星有些版本把题目放在**再套一层的 iframe** 里（外壳 frame 里只有个 iframe）。
   * 那种情况下，外壳 frame 的 role 判定是对的（URL 含 /work/），但
   * document.querySelector('.TiMu') 永远是 0，于是脚本一直"在观察但什么都看不到"。
   * 同源的话可以直接访问 contentDocument 把题目捞出来。
   *
   * ⚠️ 但必须跳过"已经有自己脚本实例"的嵌套文档 —— 真实案例：
   *   /ananas/modules/work/index.html   ← 外壳，URL 也含 /work/，被判为 work
   *     └ iframe /mooc-ans/work/doHomeWorkNew  ← 真正的测验页，同样被判为 work
   *   两者同源，外壳能钻进内层看到同一批题。如果两边都处理，就会
   *     · 重复调一次答题 API（浪费）
   *     · 重复点击同一个选项 —— 多选题的 checkbox 被点两次等于取消勾选，直接答错
   *   所以这里靠 FRAME_MARK 认亲：那一层有自己的脚本，就交给它，自己让开。
   *
   * 跨域访问会抛异常，捕获后跳过（跨域是真的没办法，只能靠用户从诊断里看出来）。
   *
   * 返回：含题目的 Document，或 null。
   */
  function questionRoot() {
    try {
      if (document.querySelector(QUESTION_ANY)) return document;
    } catch (e) { /* 选择器异常，继续往下试 */ }

    let frames = [];
    try { frames = document.querySelectorAll('iframe'); } catch (e) { return null; }
    for (const f of frames) {
      try {
        const d = f.contentDocument;               // 跨域时抛异常或为 null
        if (!d) continue;
        if (markedByScript(d)) continue;           // 那一层有自己的脚本实例，别抢
        if (d.querySelector(QUESTION_ANY)) return d;
      } catch (e) { /* 跨域，跳过 */ }
    }
    return null;
  }

  /* ============================================================
   * 3.6 超星的字体混淆检测（font-cxsecret）
   * ============================================================ */

  /*
   * 超星给题干和选项套了一层「字体混淆」。
   *
   * 真机实测（2026-09-22，章节测验 doHomeWorkNew）：
   *   题干容器是 <div class="clearfix font-cxsecret fontLabel">，
   *   每个选项是 <a class="fl after">（也带 font-cxsecret），
   *   CSS 里有一条**内联 base64 TTF** 的 @font-face。
   *
   * 机制：**DOM 里放的是"错"的字，靠这个自定义字体把字形渲染成"对"的字。**
   *   页面文本 = 增强寕患意识，是中国共寍党战胜寖种风险挑战
   *   真实文本 = 增强忧患意识，是中国共产党战胜各种风险挑战
   * 读 charCodeAt 拿到的是 U+5BD5，而不是 忧 的 U+5FE7 ——
   * **错在源头，不是我们转码转坏的**，所以换编码、换接口都救不回来。
   * 实测规模：171 个汉字里 56 个（32.7%）被替换；被替换的字全部落在
   * U+5B89~U+5BFE 这个窄区间；而且同一个真字在不同题里映射还不一样
   * （第 1 题的"的"原样，第 2 题的"的"被换成"寠"）→ 没有全局替换表可硬编码。
   *
   * 对答题模块是致命的：我们送进大模型的就是这段错文本，模型再强也答不对。
   * 最坏的地方在于**整条链路一个错都不报** —— 角色识别对、抓到 N 道题、
   * 请求发出、答案回填到元素上、提交成功，日志全绿，只是答案全错。
   * 开着 autoSubmit 就会把一份**错答案卷子**交上去，而章节测验往往只允许提交一次。
   *
   * 所以这里的选择是：**认出来、说出来、停手**，而不是硬着头皮答。
   * 真要恢复作答，得先把文本还原（字形比对已验证可行：乱码字在 cxsecret 下的
   * 字形与真字在普通字体下的字形 IoU 0.71~0.89，而"毫不相干的字"基线是 0.164）。
   * 在那之前，**少答一次好过交一份错的**。
   *
   * 判据用类名而不是 computed font-family：一次 querySelector 就够，不触发样式计算。
   * 类名万一被改，还有 fontObfuscationByStyle() 兜底。
   */
  function detectFontObfuscation(root) {
    const scope = root || document;
    try {
      if (scope.querySelector('[class*="font-cxsecret"]')) return true;
    } catch (e) { /* 选择器异常，交给兜底那层 */ }
    return false;
  }

  /*
   * 类名被改掉时的兜底：看题目元素的 computed font-family 里有没有可疑字体。
   *
   * ⚠️ 这个贵 —— 每个元素一次 getComputedStyle（会触发样式计算），
   * 而且字体可能挂在容器的**子元素**上（实测就是 div.clearfix.fontLabel），
   * 所以必须往下钻一层。因此它**只在类名判据失败时跑一次**，结果由调用方缓存，
   * 绝不能放进每轮观察的循环里。
   */
  function fontObfuscationByStyle(containers) {
    const SUSPECT = /secret|obfus/i;
    const probe = (el) => {
      try {
        if (SUSPECT.test(getComputedStyle(el).fontFamily || '')) return true;
      } catch (e) { /* 忽略 */ }
      return false;
    };
    for (const c of containers || []) {
      if (probe(c)) return true;
      let inner = [];
      try { inner = c.querySelectorAll('div, span, a, p, i, em, b'); } catch (e) { continue; }
      for (const n of inner) if (probe(n)) return true;
    }
    return false;
  }

  /* ===== 字形参照表（自动生成的数据块，勿手改）===== */
  /*
   * ★ 位置有讲究：必须留在 3.7 节**之前**。
   *   3.7 节顶层要算 `const SF_PIX = CX_FONT_BOX * CX_FONT_BOX`，
   *   而 const 在声明前是 TDZ —— 读它会抛 ReferenceError，
   *   整个 IIFE 直接崩在顶层，浏览器里表现为「脚本完全没反应」。
   *   这是 v1.5.7 真实翻过的车，别把它挪回文件末尾。
   *
   * 体量说明：CX_FONT_ATLAS 约 227KB base64、CX_FONT_CODES 约 18KB，
   * 占了整个脚本一多半。它是「能答题」与「不能答题」的分界，不是可选项。
   * 嫌大也别删 —— 删了脚本会退回「认出来就停手」的行为（见 checkFontObfuscation）。
   *
   * 下面这段表头由 bench/_gen-font-atlas.py 生成，勿手改。
   */
/* ==================================================================
 * 字形参照表（自动生成，勿手改）
 *
 * 由 bench/_gen-font-atlas.py 生成，参数见该脚本头部注释。
 * 用途：超星用 font-cxsecret 自定义字体把生僻码位渲染成常用字，
 *       DOM 里存的是生僻字，肉眼看到的是常用字。这里把常用字
 *       渲染成 16×16 位图存下来，运行时拿混淆字体的字形去比。
 *
 * 候选字 6763 个（GB2312 汉字区全集），按码位顺序排列。
 * CX_FONT_CODES 与 CX_FONT_ATLAS 的索引一一对应。
 * ================================================================== */
const CX_FONT_BOX = 16;
const CX_FONT_COLS = 64;
const CX_FONT_ATLAS = `
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
h/WHX1/y71V3TM/4qM/JfTxZGQDT2/EPZskKqrSiTqnxPTSAWAT3N6OlzBUlcoX1DX/0UeVQbvvY9pvUm3xzy+erue7niFuje2vv
ZyGQKis7coDBQFwaxAXJJq0my76U15aEVxDBvPsMDsi6H8A85a+wAi+6+4ndtfUz7/k8+tQEKNvHBl4bO7d7VJL2+ZjF1WCF7pej
6opHyQcz4ONmm2PAJbhcYCejsacZpWpfWUJwnkVUNUiZFpnvzlD+DefZVuyIlMQfjfr/TQgijqOFvgQpen2fst41rDbb48utg241
W0bV53ugz2Z2G3jOM9fvzLgROaL587Vn1PajaFtnfFnKj44wM/+vPkmsavPMFWfINo2mCK0GkMSiK0yrkN9xbHMhHPpZxqOT8QyA
Z54c07pVyyfdmDn9a74xKkcHBORvLs12yHIU6TMDuflFKZoCTTfys5vaa8QG3UrGRHLQbe2Wxb6PH+7xeP7jiq2g/sFYCYnhO/+s
kd8Go79ayUq9G/KgXPfG9k5mAs+6LPQPhfA69pvADc1nJ5xm6uzDR//t9Xr8zGzk0xrW53nBglsdpjQfupOXOGtgb94LNlFtlTrn
fpmGc3/h8yf3Rbez/dz+yr8Pls+vPSpke5qswb2LWZ3vmjN8Cp4Mfb4z+pCSzRL9nnRa2TnsyUjgNZuQ1HckyZakdrzJE0uiQFPt
wrqy4GVjxs9uuMmJZHz/wJ14sSy7dUDPokraeprg1WZoUC4ij+M49c2FDTVEzcJ6jqPT6zY07RNpqqSKboCKIouqPc47ut6ziVF9
Ct+DK87noPXtc0UgJUGfkfFDjQegvwd6gTHAncQCk1eShXtmeSZSLGY5noNUoMFu2ROe/SgFeyp2DeZD7HghiLySqY6AHQhbfH7q
8yPfIw2MLZQsliDg5Sre9NE+47h+9T+0mvMb5T97k4Se7nE0iFk50Y4TSScA9NIsc1MvVp1a7Zw1xz5Rd30E8pT27375wH791Nwb
LGTPBZI01wPNipFpKcXs3Ad+9AIQ7tjx//H09o9RlPf6/2seyI6YZBdETTAmC1Kh1ock0BI0ZBekSi1Veurp1/b0ISAF2mNtFI8G
XbOzIUK0ItFyWqCRjUrV9nhafDgVLZBJiBI1ZKKlFm0kG4jsQpWdZBczu5mZ+/tD6Ocf2Ozembnv9/1+X9frSm5K9mrCqiwbIE1F
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
`.replace(/\s+/g, '');
const CX_FONT_CODES = `
SlU/lsNXKGPOVAlVwFSRdkx2PIXud36CjXgxcpiWjZcobIlb+k8JY5dmuFz6gEhoroACZs52+VFWZaxx8X+EiLJQZVnKYbNvrYJM
Y1Ji7VMnVAZ7a1GkdfRd1GLLjXaXimIZgF1XOJdifzhyfXbPZ352RmRwTyWN3GIXepFl7XMsZHNiLIKBmH9nSHJuYsxiNE/jdEpT
nlLKfqaQLl6GaJxpgIHRftJoxXiMhlGVjVAkjN6C3oAFUxKJZVKEhfmW3U8hWHGZnVuxYqVitGZ5jI2cBnJvZ5F4smBRUxdTiI/M
gB2NoZQNUMhyB1nrYBlxq4hUWe+CLGcoeyld934tdfVsZo74jzyQO5/UaxmRFHt8X6d41oQ9hdVr2WvWawFeh175de2VXWUKX8Vf
n4/BWMKBf5Bblq2XuY8WfyyNQWK/T9hTXlOoj6mPq49NkAdoal+YgWiI1pyLYStSKnZsX4xl0m/obr5bSGR1UbBRxGcZTsl5fJmz
cMV1dl67c+CDrWToYrWU4mxaU8NSD2TClJR7L08bXjaCFoGKgSRuymxzmlVjXFP6VGWI4FcNTgNeZWs/fOiQFmDmZBxzwYhQZ01i
Io1sdymOx5FpX9yDIYUQmcJTlYaLa+1g6GB/cM2CMYLTTqdsz4XNZNl8/Wn5ZkmDlVNWe6dPjFFLbUJcbY7SY8lTLIM2g+VntHg9
ZN9blFzuXeeLxmL0Z3qMAGS6Y0mHi5kXjCB/8pSnThCWpJgMZhZzOlcdXDhef5V/UKCAglNeZUV1MVUhUIWNhGKelB1nMlZub+Jd
NVSScGaPb2KkZKNje1+Ib/SQ44GwjxhcaGbxX4lsSJaBjWyIkWTwec5XWWoQYkhUWE4LeulghG/ai39iHpCLmuR5A1T0dQFjGVNg
bN+PG19wmjuAf5+ITzpcZI3Ff6VlvXBFUbJRa4YHXaBbvWJskXR1DI4gegFheXvHTvh+hXcRTu2BHVL6UXFqqFOHjgSVz5bBbmSW
WmlAeKhQ13cQZOaJBFnjY91df3o9aSBPOYKYVTJOrnWXemJeil7vlRtSOVSKcHZjJJWCVyVmP2mHkQdV822vfiKIM2LwfrV1KIPB
eMyWno9IYfd0zYtkazpSUI0ha2qAcYTxVgZTzk4bTtFRl3yLkQd8w09/juF7nHpnZBRdrFAGgQF2uXzsbeB/UWdYW/hby3iuZBNk
qmMrYxmVLWS+j1R7KXZTYidZRlR5a6NQNGImXoZr4043jYuIhV8ukCBgPYDFYjlOVVP4kLhjxoDmZS5sRk/uYOFt3os5X8uGU18h
Y1pRYYNjaABSY2NIjhJQm1x3efxbMFI7erxgU5DXdrdfl1+EdmyOb3B7dkl7qnfzUZOQJFhOT/Ru6o9MZRt7xHKkbd9/4Vq1YpVe
MFeChCx7HV4fXxKQFH+gmIJjx26YeLlweFFbl6tXNXVDTzh1l17mYGBZwG2/a4l4/FPVlstRAVKJYwpUk5QDjMyNOXKfeHaH7Y8N
jOBTAU7vdu5TiZR2mA6fLZWaW6KLIk4cTqxRY4TCYahSC2iXT2tgu1EebVxRlmKXZWGWRowXkNh1/ZBjd9JrinLscvuLNVh5d0yN
XGdAlZqApl4hbpJZ73rtdzuVtWutZQ5/BlhRUR+W+VupWChUco5mZX+Y5FadlP52QZCHY8ZUGlk6WZtXso41Z/qNNYJBUvBgFVj+
huhcRZ7ET52YuYslWnZghFN8Yk+QApF/mWlgDIA/UTOAFFx1mTFtjE4wjdFTWn9PexBPT04AltVs0HPphQZeanX7fwpq/neSlEF+
4VHmcM1T1I8DgymNr3JtmdtsSlezgrllqoA/YjKWqFn/Tr+Lun4+ZfKDXpdhVd6YpYAqU/2LIFS6gJ9euGw5jayCWpEpVBtsBlK3
fl9XGnF+bIl8S1n9Tv9fJGGqfDBOAVyrZwKH8FwLlc6Yr3X9cCKQr1Edf72LSVnkUVtPJlQrWXdlpIB1W3ZiwmKQj0VeH2wmew9P
2E8NZ25tqm2PebGIF18rdZpihY/vT9yRp2UvgVGBnF5QgXSNb1KGiUuNDVmFUNhOHJY2cnmBH43MW6OLRJaHWRp/kFR2Vg5W5Ys5
ZYJpmZTWdolucl4YdUZn0Wf/ep2Ado0fYcZ5YmVjjYhRGlKilDh/m4CyfpdcL25gZ9l7i3bYmo+BlH/VfB5kUJU/ekpU5VRMawFk
CGI9nvOAmXVyUmmXW4Q8aOSGAZaUluyUKk4EVNl+OWjfjRWA9GaaXrl/wlc/gJdo5V07ZZ9SbWCan5tPrI5sUatbE1/pXV5s8WIh
jXFRqZT+Up9s34LXcqJXhGctjR9ZnI/Hg5VUjXswT71sZFvRWROf5FPKhqiaN4yhgEVlfpj6VseWLlLcdFBS4VsCYwKJVk7QYipg
+mhzUZhboFHCiaF7hplQf+9gTHAvjUlRf14bkHB0xIktV0V4Ul+fn/qVaI88m+GLeHZCaNxn6o01jT1Sio/abs1oBZXtkP1WnGf5
iMePyFS4mmlbd20mbKVOs1uHmmORqGGvkOmXK1S1bdJb/VGKVVV/8H+8ZE1j8WW+YY1gCnFXbElsL1ltZyqC1ViOVmqM62vdkH1Z
F4D3U2ltdVSdVXeDz4M4aL55jFRVTwhU0naJjAKWs2y4bWuNEIlknjqNP1bRntV1iF/gcmhg/FSoTipqYYhSYHCPxFTYcHmGP54q
bY9bGF+ifolVr080czxUmlMZUA5UfFROTv1fWnT2WGuE4YB0h9ByynxWbidfToYsVaRikk6qbDdisYLXVE5TPnPRbjt1ElIWU92L
0GmKXwBg7m1PVyJrr3NTaNiPE39iY6NgJFXqdWKMFXGjbaZbe15Sg0xhxJ76eFeHJ3yHdvBR9mBMcUNmTF5NYA6McHAlY4mPvV9i
YNSG3lbBa5RgZ2FJU+BgZmY/jf15Gk/pcEdss4vyi9h+ZIMPZlpaQptRbfdtQYw7bRlPa3C3gxZi0WANlyeNeHn7UT5X+lc6Z3h1
PXrveZV7jIBlmfmPwG+liyGe7Fnpfgl/CVSBZ9hokY9NfMaWylMlYL51cmxzU8lap34kY+BRCoHxXd+EgGKAUWNbDk9teUJSuGBO
bcRbwluhi7CL4mXMX0WWk1nnfqp+CVa3ZzlZc0+2W6BSWoOKmD6NMnW+lEdQPHr3TrZnfprBWnxr0XZaVxZcOnv0lU5xfFGpgHCC
eFkEfyeDwGjsZ7F4d3jjYmFjgHvtT2pSz1FQg9tpdJL1jTGNwYkula179k5lUDCCUVJvmRBuhW6nbfpe9VDcWQZcRm1fbIZ1i4Ro
aFZZsosgU3GRTZZJhRJpAXkmcfaApE7KkEdthJoHWrxWBWTwlOt3pU8ageFy0ol6mTR/3n5/UllldZF/j4OP61OWeu1jpWOGdvh5
V4g2lipiq1KCglRocGd3Y2t37XoBbdN+44nQWRJiyYWlgkx1H1DLTqV164tKXP5dS3ukZdGRyk4lbV+JJ30mlcVOKIzbj3OXS2aB
edGP7HB4bT1cslJGg2JRDoNbd3ZmuJysTspgvnyzfM9+lU5mi29miJhZl4NYbGVclYRfyXVWl9963nrAUa9wmHrqY3Z6oH6Wc+2X
RU54cF1OUpGpU1Fl52X8gQWCjlQxXJp1oJfYYtlyvXVFXHmayoNAXIBU6Xc+Tq5sWoDSYm5j6F13Ud2NHo4vlfFP5VPnYKxwZ1JQ
Y0OeH1omUDd3d1PifoVkK2WJYphjFFA1csmJs1HAi91+R1fMg6eUm1EbVPtcyk/jelpt4ZCPmoBVllRhU69UAF/pY3dp71FoYQpS
KljYUk5XDXgLd7ded2HgfFtil2KiTpVwA4D3YuRwYJd3V9uC72f1aNV4l5jRefNYs1TvUzRuS1E7UqJb/ouvgENVpldzYFFXLVR6
elBgVFunY6Bi41NjYsdbr2ftVJ965oJ3kZNe5Ig4Wa5XDmPoje+AV1d3e6lP61+9Wz5rIVNQe8JyRmj/dzZ392W1UY9O1Ha/XKV6
dYROWUGbgFCImSdhg25kVwZmRmPwVuxiaWLTXhSWg1fJYodVIYdKgaOPZlWxg2VnVo3dhGpaD2jmYu57EZZwUZxvMIz9Y8iJ0mEG
f8Jw5W4FdJRp/HLKXs6QF2dqbV5js1JicgGAbE/lWWqR2XCdbdJSUE73lm2VfoXKeC99IVGSV8Jki4B7fOps8WheabdRmFOoaIFy
zp7xe/hyu3kTbwZ0TmfMkaScPHmJg1SDD1QXaD1OiVOxUj54hlMpUohQi0/QT+J1y3qSfKVstpabUoN06VTpT1SAsoPej3CVyV4c
YJ9tGF5bZTiB/pRLYLxww36ufMlRgWixfG+CJE6Gj8+RfmauTgWMqWRKgNpQl3XOceVbvY9mb4ZOgmRjldZemWUXUsKIyHCjUg5z
M3SXZ/d4Fpc0TruQ3pzLbdtRQY0dVM5isnPxg/aWhJ/DlDZPmn/MUXVwdZatXIaY5lPkTpxuCXS0aWt4j5lZdRhSJHZBbfNnbVGZ
n0uAmVQ8e796hpaEV+JiR5Z8aQRaAmTTew9vS5amgmJThZiQXolws2NkU0+GgZyTnox4MpfvjUKNf55eb4R5VV9Gli5idJoVVN2U
o0/FZWVcYVwVf1GGL2yLX4dz5G7/fuZcG2NqW+ZudVNxTqBjZXWhYm6PJk/RTqZstn66ix2EuodXfzuQI5Wpe6Ga+Ig9hBtthprc
fohZu56bcwF4goZsmoKaG1YXVMtXcE6mnlZTyI8JgZJ3kpnuhuFuE4X8ZmJhK28pjJKCK4PydhNs2V+9gytzBYMaldtr23fGlG9T
AoOSUT1ejIw4jUhOq3OaZ4VodpEJl2RxoWwJd5JaQZXPa45/J2bQW7lZmlrolfeV7E4MhJmErGrfdjCVG3OmaF9bL3eakWGX3Hz3
jxyMJV9zfNh5xYnMbByHxltCXsloIHf1fpVRTVHJUilaBX9il9eCz2OEd9CF0nk6bplemVkRhW1wEWy/Yr92T2WvYP2VDmafhyOe
7ZQNVH1ULIx4ZHlkEYYhapyB6HhpZFSbuWIrZ6uDqFjYnqtsIG/eW0yWC4xfctBnx2JhcqlOxlnNa5NYrmZVXt9SVWEoZ+52Zndn
ckZ6/2LqVFBUoJSjkBxas34WbENOdlkQgEhZV1M3db6WylYgYxGBfGD5ldZtYlSBmYVR6Vr9gK5ZE5cqUOVsPFzfYmBPP1N7gQaQ
um4rhchidF6+eLVke2P1Xxhaf5Efnj9cT2NCgH1bblVKlU2VhW2oYOBn3nLdUYFb52LebFtybWKulL1+E4FTbZxRBF90WapSEmBz
WZZmUIafdSpj5mHvfPqL5lQnayWetGvVhVVUdlCkbGpVtI0schVeFWA2dM1ikmNMcphfQ24+bQBlWG/YdtB4/HZUdSRS21NTTp5e
wWUqgNaAm2KGVChSrnCNiNGN4Wx4VNqA+Vf0iFSNapZNkWlPm2y3VcZ2MHioYvlwjm9tX+yE2mh8ePd7qIELZ0+eZ2OweG9XEng5
l3liq2KIUjV012tkVT6BsnWudjlT3nX7UEFcbIvHe09QR3KXmtiYAm/idGh5h2Sld/xikZgrjcFUWIBSTmpX+YINhHNe7VH2dMSL
T1xhV/xsh5hGWjR4RJvrj5V8VlJRYvqUxk6Gg2GE6YOyhNRXNGcDV25mZm0xjN1mEXAfZzprFmgaYrtZA07EUQZv0mePbHZRy2hH
WWdrZnUOXRCBUJ/XZUh5QXmRmneNglxeTgFPL1RRWQx4aFYUbMSPA199bONsq4uQY3BgPW11cmZijpTFlENTwY9+e99OJox+TtSe
sZSzlE1SXG9jkEVtNIwRWExdIGtJa6pnW1RUgYx/mVg3hTpfomJHajmVcmWEYGVop3dUTqhP512Yl6xk2H/tXM9PjXoHUgSDFE4v
YIN6ppS1T7JO5nk0dORSuYLSZL153VuBbFKXe48ibD5Qf1MFbs5kdGYwbMVgd5j3i4ZePHR3est5GE6xkAN0QmzaVkuRxWyLjTpT
xobyZq+OSFxxmiBu1lM2Woufo427UwhXp5hDZ5uRyWxoUcp182KscjhSnVI6f5RwOHZ0U0qet2lueMCW2YikfzZxw3GJUdNn5HTk
WBhlt1api3aZcGLVfvlg7XDsWMFOuk7NX+eX+06kiwNSilmrflRizU7lZQ5iOIPJhGODjYeUcbZuuVvSfpdRyWPUZ4mAOYMViBJR
eluCWbGPc05dbGVRJYlvjy6WSoVedBCV8JWmbeWCMV+SZBJtKIRugcOcXlhbjQlOwVMeT2NlUWjTVSdOFGSammtiwlpfdHKCqW3u
aOdQjoMCeEBnOVKZbLF+u1BlVV5xW3tSZspz64JJZ3FcIFJ9cWuI6pVVlsVkYY2zgYRVVWxHYi5/klgkT0ZVT41MZgpOGlzziKJo
TmMNeudwjYL6UvaXEVzoVLWQzX5iWUqNx4YMgg2CZo1EZARcUWGJbT55vos3eDN1e1Q4T6uO8W0gWsV+XnmIbKFbdloadb6ATmEX
bvBYH3UldXJyR1PzfgF323ZpUtyAI1cIXjFZ7nK9ZX9u14s4XHGGQVPzd/5i9mXATt+YgIaeW8aL8lPid39PTlx2mstZD186eetY
Fk7/Z4tO7WKTih2Qv1IvZtxVbFYCkNVOjU/KkXCZD2wCXkNgpFvGidWLNmVLYpaZiFv/W4hjLlXXUyZ2fVEshaJns2iKa5Jik4/U
UxKC0W2PdWZOTo1wW59xr4WRZtlmcn8Ah82eIJ9eXC9n8I8RaF9nDWLWeoVYtl5wZTFvVWA3Ug2AVGRwiCl1BV4TaPRiHJfMUz1y
AYw0bGF3DnouVKx3epgcgvSLVXgUZ8Fwr2WVZDZWHWDBefhTHU57a4aA+lvjVdtWOk88T3KZ811+ZziAAmCCmAGQi1u8i/WLHGRY
gt5k/VXPgmWR108gfR+Qn3zzUFFYr26/W8mLg4B4kZyEl3t9houWj5blftOajniBXFd6QpCnll95WVtfYwt70YStaAZVKX8QdCJ9
AZVAYkxY1k6DW3lZVFhtcx5jS44Pjs6A1IKsYvBT8GxekSpZAWBwbE1XSmQqjSt26W5bV4Bq8HVtby2MCIxmV+9rkoizeKJj+VOt
cGRsWFgqZAJY4GibgRBV1nwYULqOzG2fjetwj2ObbdRu5n4EhENoA5DYbXaWqItXWXly5IV+gbx1ioqvaFRSIo4RldBjmJhEjnxV
U0//Zo9W1WCVbUNSSVwpWftta1gwdRx1bGAUgkaBEWNhZ+KPOnfzjTSNwZQWXoVTLFTDcEBs915cUK1OrV46Y0eCGpBQaG6Rs3cM
VNyUZF/lenZoRWNSe99+23V3UJViNFkPkPhRw3mBev5Wkl8UkIJtYFwfVxBUVFFNbuJWqGOTmH+BFYcqiQCQHlRvXMCB1mJYYjGB
NZ5Alm6afJotaaVZ02I+VRZjx1TZhjxtA1rmdJyIamsWWUyML19+bqlzfZg4TvdwjFuXeD1jWmaWdstgm1tJWgdOVYFqbItzoU6J
Z1F/gF/6ZRtn2F+EWQFazV2uX3FT5pfdj0Vo9FYvVd9gOk5Nb/R+x4IOhNRZH08qTz5crH4qZxqFc1RPdcOAglVPm01PLW4TjAlc
cGFrUx92KW6Khodl+5W5fjtUM3oKfe6V4VXBf+50HWMXh6FtnXoRYqFlZ1PhY4Ns611cVKiUTE5hbOyLS1zgZZyCp2g+VDRUy2tm
a5ROQmNIUx6CDU+uT15XCmL+lmRmaXL/UqFSn2DvixRmmXGQZ3+JUnj9d3BmO1Y4VCGVenIAem9gDF6JYJ2BFVncYIRx73CqblBs
gHKEaq2ILV5gTrNanFXjlBdt+3yZlg9ixn6Od36GI1Mel5aPh2bhXKBP7XILTqZTD1kTVIBjKJVIUdlOnJykfrhUJI1UiDeC8pWO
bSZfzFo+ZmmWsHMuc79TeoGFmaF/qlt3llCWv374dqJTdpWZmbF7RIlYbmFO1H9leeaL82DNVKtOeZj3XWFqz1ARVGGMJ4RdeASX
SlLuVKNWAJWIbbVbxm1TZg9cXVshaJaAeFURe0hlVGmbTkdrToeLl09TH2M6ZKqQnGXBgBCMmVGwaHhT+YfIYcRs+2wijFFcqoWv
ggyVI2ubj7Bl+1/DX+FPRYgfZmWBKXP6YHRREVKLV2JfopBMiJKReF5PZydg01lEUfZR+IAIU3lsxJaKcRFP7k+efz1nxVUIlcB5
lojjfp9YDGIAl1qGGFZ7mJBfuIvEhFeR2VPtZY9eXHVkYG59f1rqfu1+aY+nVaNbrGDLZYRzCZBjdil32n50l5uFZlt0euqWQIjL
Uo9xql/sZeKL+1tvmuFdiWtbbK2Lr4sKkMWPi1O8YiaeLZ5AVCtOvYJZcpyGFl1ZiK9txZbRVJpOtosJcb1UCZbfcPlt0HYlThR4
EoepXPZeAIqcmA6WjnC/bERZqWM8d02IFG9zgjBY1XGMUxp4wZYBVWZfMHG0WxqMjJqDay5ZL57neWhnbGJvT6F1in8LbTOWJ2zw
TtJ1e1E3aD5vgJBwgZZZdnRHZCdcZZCReiOM2lmsVACCb4OBiQCAMGlOVjaAN3LOkbZRX051mJZjGk72U/NmS4EcWbJtAE75WDtT
1mPxlJ1PCk9jiJCYN1lXkPt56k7wgJF1gmycW+hZXV8FaYGGGlDyXVlO43flTnqCkWITZpGQeVy/TnlfxoE4kISAq3WmTtSID2HF
a8ZfSU7KdqJu44uuiwqM0YsCX/x/zH/OfjWDa4PgVrdr85c0lvtZH1T2lOttxVtumTlcFV+QlnBT8YIxanRacJ6UXih/uYMkhCWE
Z4NHh86PYo3IdnFflphseCBm31TlYmNPw4HIdbhezZYKjvmGj1TzbIxtOGx/YMdSKHV9XhhPoGDnXyRcMXWukMCUuXK5bDhuSZEJ
Z8tT81NRT8mR8YvIU3xewo/kbY5OwnaGaV6GGmEGgllP3k8+kHycCWEdbhRuhZaITjFa6JYOTn9cuXmHW+2LvX+Jc99Xi4LBkAFU
R5C7VepcoV8IYTJr8XKygImKdG3TW9WIhJhrjG2aM54KbqRRQ1GjV4GIn1P0Y5WP7VZYVAZXP3OQbhh/3I/Rgj9hKGBilvBmpn6K
jcONpZSzXKR8CGemYAWWGICRTueQAFNolkFR0I90hV2RVWb1l1VbHVM4eEJnPWjJVH5wsFt9j41RKFexVBJlgmZejUOND4FshG2Q
33z/UfuFo2fpZaFvpIaBjmpWIJCCdnZw5XEjjeliGVL9bDyNDmCeWI5h/mZgjU5is1Ujbi1nZ4/hlPiVKHcFaKhpi1RNTrhwyItY
ZItlhVuEejpQ6Fu7d+FreYqYfL5sz3apZZePLV1VXDiGCGhgUxhi2Xpbbv1+H2rgenBfM28gX4xjqG1WZwhOEF4mjddOwIA0dpyW
22ItZn5ivGx1jWdxaX9GUYeA7FNukJhi8lTwhpmPBYAXlReF2Y9Zbc1zn2UfdwR1J3j7gR6NiJSmT5VnuXXKiweXL2NHlTWWuIQj
Y0F3gV/wcolOFGB0Ze9iY2s/ZSdex3XRkMGLnYKdZy9lMVQYh+V3ooACgUFsS07HfkyA9HYNaZZrZ2I8UIRPQFcHY2Jrvo3qU+hl
uH7XXxpjt2PzgfSBbn8cXtlcNlJ6Zul5GnoojZlw1HXebrtsknotTsV24F+flHeIyH7Neb+AzZHyThdPH4JoVN5dMm3Mi6V8dI+Y
gBpeklSxdplbPGakmuBzKmjbhjFnKnP4i9uLEJD5ettwbnHEYql3MVY7TleE8WepUsCGLo34lFF7T0/obF15e5qTYipy/WITThZ4
bI+wZFqNxntpaIRexYiGWZ5k7li2cg5pJZX9j1iNYFcAfwaMxlFJY9liU1NMaCJ0AYNMkURVQHd8cEpteVGoVESN/1nLbsRtXFsr
fdROfXzTblBb6oENbldbA5vVaCqOl1v8fjtgtX65kHCNT1nNY995s41SU89lVnnFizuWxH67lIJ+NFaJkQBnan8KXHWQKGbmXVBP
3mdaUFxPUFenXo1ODE5AURBO/15FUxVOmE4eTjKbbFtpVihOunk/ThVTR04tWTtyblMQbN9W5ICXmdNrfncXnzZOn04Qn1xOaU6T
ToiCW1tsVQ9WxE6NU51To1OlU65TZZddjRpT9VMmUy5TPlNcjWZTY1MCUghSDlItUjNSP1JAUkxSXlJhUlxSr4R9UoJSgVKQUpNS
glFUf7tOw07JTsJO6E7hTutO3k4bT/NOIk9kT/VOJU8nTwlPK09eT2dPOGVaT11PX09XTzJPPU92T3RPkU+JT4NPj09+T3tPqk98
T6xPlE/mT+hP6k/FT9pP40/cT9FP30/4TylQTFDzTyxQD1AuUC1Q/k8cUAxQJVAoUH5QQ1BVUEhQTlBsUHtQpVCnUKlQulDWUAZR
7VDsUOZQ7lAHUQtR3U49bFhPZU/OT6CfRmx0fG5R/V3JnpiZgVEUWflSDVMHihBT61EZWVVRoE5WUbNOboikiLVOFIHSiIB5NFsD
iLh/q1GxUb1RvFHHUZZRolGlUaCLpouni6qLtIu1i7eLwovDi8uLz4vOi9KL04vUi9aL2IvZi9yL34vgi+SL6Ivpi+6L8Ivzi/aL
+Yv8i/+LAIwCjASMB4wMjA+MEYwSjBSMFYwWjBmMG4wYjB2MH4wgjCGMJYwnjCqMK4wujC+MMowzjDWMNoxpU3pTHZYiliGWMZYq
lj2WPJZClkmWVJZflmeWbJZylnSWiJaNlpeWsJaXkJuQnZCZkKyQoZC0kLOQtpC6kLiQsJDPkMWQvpDQkMSQx5DTkOaQ4pDckNeQ
25DrkO+Q/pAEkSKRHpEjkTGRL5E5kUORRpENUkJZolKsUq1SvlL/VNBS1lLwUt9T7nHNd/Re9VH8US+btlMBX1p1711MV6lXoVd+
WLxYxVjRWClXLFcqVzNXOVcuVy9XXFc7V0JXaVeFV2tXhld8V3tXaFdtV3ZXc1etV6RXjFeyV89Xp1e0V5NXoFfVV9hX2lfZV9JX
uFf0V+9X+FfkV91XC1gNWP1X7VcAWB5YGVhEWCBYZVhsWIFYiViaWIBYqJkZn/9heYJ9gn+Cj4KKgqiChIKOgpGCl4KZgquCuIK+
grCCyILKguOCmIK3gq6Cy4LMgsGCqYK0gqGCqoKfgsSCzoKkguGCCYP3guSCD4MHg9yC9ILSgtiCDIP7gtOCEYMagwaDFIMVg+CC
1YIcg1GDW4NcgwiDkoM8gzSDMYObg16DL4NPg0eDQ4Nfg0CDF4Nggy2DOoMzg2aDZYNogxuDaYNsg2qDbYNug7CDeIOzg7SDoIOq
g5ODnIOFg3yDtoOpg32DuIN7g5iDnoOog7qDvIPBgwGE5YPYgwdYGIQLhN2D/YPWgxyEOIQRhAaE1IPfgw+EA4T4g/mD6oPFg8CD
JoTwg+GDXIRRhFqEWYRzhIeEiIR6hImEeIQ8hEaEaYR2hIyEjoQxhG2EwYTNhNCE5oS9hNOEyoS/hLqE4IShhLmEtISXhOWE44QM
hQ11OIXwhDmFH4U6hVaFO4X/hPyEWYVIhWiFZIVehXqFondDhXKFe4WkhaiFh4WPhXmFroWchYWFuYW3hbCF04XBhdyF/4UnhgWG
KYYWhjyG/l4IXzxZQVk3gFVZWllYWQ9TIlwlXCxcNFxMYmpin2K7Yspi2mLXYu5iImP2YjljS2NDY61j9mNxY3pjjmO0Y21jrGOK
Y2ljrmO8Y/Jj+GPgY/9jxGPeY85jUmTGY75jRWRBZAtkG2QgZAxkJmQhZF5khGRtZJZkemS3ZLhkmWS6ZMBk0GTXZORk4mQJZSVl
LmULX9JfGXURX19T8VP9U+lT6FP7UxJUFlQGVEtUUlRTVFRUVlRDVCFUV1RZVCNUMlSCVJRUd1RxVGRUmlSbVIRUdlRmVJ1U0FSt
VMJUtFTSVKdUplTTVNRUclSjVNVUu1S/VMxU2VTaVNxUqVSqVKRU3VTPVN5UG1XnVCBV/VQUVfNUIlUjVQ9VEVUnVSpVZ1WPVbVV
SVVtVUFVVVU/VVBVPFU3VVZVdVV2VXdVM1UwVVxVi1XSVYNVsVW5VYhVgVWfVX5V1lWRVXtV31W9Vb5VlFWZVepV91XJVR9W0VXr
VexV1FXmVd1VxFXvVeVV8lXzVcxVzVXoVfVV5FWUjx5WCFYMVgFWJFYjVv5VAFYnVi1WWFY5VldWLFZNVmJWWVZcVkxWVFaGVmRW
cVZrVntWfFaFVpNWr1bUVtdW3VbhVvVW61b5Vv9WBFcKVwlXHFcPXhleFF4RXjFeO148XjdeRF5UXlteXl5hXoxcelyNXJBcllyI
XJhcmVyRXJpcnFy1XKJcvVysXKtcsVyjXMFct1zEXNJc5FzLXOVcAl0DXSddJl0uXSRdHl0GXRtdWF0+XTRdPV1sXVtdb11dXWtd
S11KXWlddF2CXZldnV1zjLddxV1zX3dfgl+HX4lfjF+VX5lfnF+oX61ftV+8X2KIYV+tcrBytHK3crhyw3LBcs5yzXLScuhy73Lp
cvJy9HL3cgFz83IDc/py+3IXcxNzIXMKcx5zHXMVcyJzOXMlcyxzOHMxc1BzTXNXc2BzbHNvc35zG4IlWeeYJFkCWWOZZ5lomWmZ
aplrmWyZdJl3mX2ZgJmEmYeZipmNmZCZkZmTmZSZlZmAXpFei16WXqVeoF65XrVevl6zXlON0l7RXtte6F7qXrqBxF/JX9Zfz18D
YO5fBGDhX+Rf/l8FYAZg6l/tX/hfGWA1YCZgG2APYA1gKWArYApgP2AhYHhgeWB7YHpgQmBqYH1glmCaYK1gnWCDYJJgjGCbYOxg
u2CxYN1g2GDGYNpgtGAgYSZhFWEjYfRgAGEOYSthSmF1YaxhlGGnYbdh1GH1Yd1fs5bpleuV8ZXzlfWV9pX8lf6VA5YElgaWCJYK
lguWDJYNlg+WEpYVlhaWF5YZlhqWLE4/chViNWxUbFxsSmyjbIVskGyUbIxsaGxpbHRsdmyGbKls0GzUbK1s92z4bPFs12yybOBs
1mz6bOts7myxbNNs72z+bDltJ20MbUNtSG0HbQRtGW0ObSttTW0ubTVtGm1PbVJtVG0zbZFtb22ebaBtXm2TbZRtXG1gbXxtY20a
bsdtxW3ebQ5uv23gbRFu5m3dbdltFm6rbQxurm0rbm5uTm5rbrJuX26GblNuVG4ybiVuRG7fbrFumG7gbi1v4m6lbqduvW67brdu
1260bs9uj27Cbp9uYm9Gb0dvJG8Vb/luL282b0tvdG8qbwlvKW+Jb41vjG94b3JvfG96b9FvyW+nb7lvtm/Cb+Fv7m/eb+Bv728a
cCNwG3A5cDVwT3BecIBbhFuVW5NbpVu4Wy91npo0ZORb7lswifBbR44Hi7aP04/Vj+WP7o/kj+mP5o/zj+iPBZAEkAuQJpARkA2Q
FpAhkDWQNpAtkC+QRJBRkFKQUJBokFiQYpBbkLlmdJB9kIKQiJCDkIuQUF9XX1ZfWF87XKtUUFxZXHFbY1xmXLx/Kl8pXy1fdII8
XzubblyBWYNZjVmpWapZo1mXWcpZq1meWaRZ0lmyWa9Z11m+WQVaBlrdWQha41nYWflZDFoJWjJaNFoRWiNaE1pAWmdaSlpVWjxa
Ylp1WuyAqlqbWndaelq+WutaslrSWtRauFrgWuNa8VrWWuZa2FrcWglbF1sWWzJbN1tAWxVcHFxaW2Vbc1tRW1NbYlt1mneaeJp6
mn+afZqAmoGahZqImoqakJqSmpOalpqYmpuanJqdmp+aoJqimqOapZqnmp9+oX6jfqV+qH6pfq1+sH6+fsB+wX7Cfsl+y37MftB+
1H7Xftt+4H7hfuh+637ufu9+8X7yfg1/9n76fvt+/n4BfwJ/A38Hfwh/C38Mfw9/EX8Sfxd/GX8cfxt/H38hfyJ/I38kfyV/Jn8n
fyp/K38sfy1/L38wfzF/Mn8zfzV/el5/ddtdPnWVkI5zkXOuc6Jzn3PPc8Jz0XO3c7NzwHPJc8hz5XPZc3yYCnTpc+dz3nO6c/Jz
D3QqdFt0JnQldCh0MHQudCx0G3QadEF0XHRXdFV0WXR3dG10fnScdI50gHSBdId0i3SedKh0qXSQdKd00nS6dOqX65fsl0xnU2de
Z0hnaWelZ4dnamdzZ5hnp2d1Z6hnnmetZ4tnd2d8Z/BnCWjYZwpo6WewZwxo2We1Z9pns2fdZwBow2e4Z+JnDmjBZ/1nMmgzaGBo
YWhOaGJoRGhkaINoHWhVaGZoQWhnaEBoPmhKaEloKWi1aI9odGh3aJNoa2jCaG5p/GgfaSBp+WgkafBoC2kBaVdp42gQaXFpOWlg
aUJpXWmEaWtpgGmYaXhpNGnMaYdpiGnOaYlpZmljaXlpm2mnabtpq2mtadRpsWnBacpp32mVaeBpjWn/aS9q7WkXahhqZWryaURq
PmqgalBqW2o1ao5qeWo9aihqWGp8apFqkGqpapdqq2o3c1JzgWuCa4drhGuSa5NrjWuaa5troWuqa2uPbY9xj3KPc491j3aPeI93
j3mPeo98j36PgY+Cj4SPh4+Lj42Pjo+Pj5iPmo/OjgtiF2IbYh9iImIhYiViJGIsYueB73T0dP90D3URdRN1NGXuZe9l8GUKZhlm
cmcDZhVmAGaFcPdmHWY0ZjFmNmY1ZgaAX2ZUZkFmT2ZWZmFmV2Z3ZoRmjGanZp1mvmbbZtxm5mbpZjKNM402jTuNPY1AjUWNRo1I
jUmNR41NjVWNWY3HicqJy4nMic6Jz4nQidGJbnKfcl1yZnJvcn5yf3KEcotyjXKPcpJyCGMyY7BjP2TYZASA6mvza/1r9Wv5awVs
B2wGbA1sFWwYbBlsGmwhbClsJGwqbDJsNWVVZWtlTXJSclZyMHJihhZSn4CcgJOAvIAKZ72AsYCrgK2AtIC3gOeA6IDpgOqA24DC
gMSA2YDNgNeAEGfdgOuA8YD0gO2ADYEOgfKA/IAVZxKBWow2gR6BLIEYgTKBSIFMgVOBdIFZgVqBcYFggWmBfIF9gW2BZ4FNWLVa
iIGCgZGB1W6jgaqBzIEmZ8qBu4HBgaaBJGs3azlrQ2tGa1lr0ZjSmNOY1ZjZmNqYs2tAX8Jr84mQZVGfk2W8ZcZlxGXDZcxlzmXS
ZdZlgHCccJZwnXC7cMBwt3CrcLFw6HDKcBBxE3EWcS9xMXFzcVxxaHFFcXJxSnF4cXpxmHGzcbVxqHGgceBx1HHncflxHXIocmxw
GHFmcblxPmI9YkNiSGJJYjt5QHlGeUl5W3lceVN5WnlieVd5YHlveWd5enmFeYp5mnmnebN50V/QXzxgXWBaYGdgQWBZYGNgq2AG
YQ1hXWGpYZ1hy2HRYQZigIB/gJNs9mz8bfZ3+HcAeAl4F3gYeBF4q2UteBx4HXg5eDp4O3gfeDx4JXgseCN4KXhOeG14VnhXeCZ4
UHhHeEx4anibeJN4mniHeJx4oXijeLJ4uXileNR42XjJeOx48ngFefR4E3kkeR55NHmbn/me+578nvF2BHcNd/l2B3cIdxp3IncZ
dy13Jnc1dzh3UHdRd0d3Q3dad2h3Yndld393jXd9d4B3jHeRd593oHewd7V3vXc6dUB1TnVLdUh1W3VydXl1g3VYf2F/X39Iimh/
dH9xf3l/gX9+f8125XYyiIWUhpSHlIuUipSMlI2Uj5SQlJSUl5SVlJqUm5SclKOUpJSrlKqUrZSslK+UsJSylLSUtpS3lLiUuZS6
lLyUvZS/lMSUyJTJlMqUy5TMlM2UzpTQlNGU0pTVlNaU15TZlNiU25TelN+U4JTilOSU5ZTnlOiU6pTplOuU7pTvlPOU9JT1lPeU
+ZT8lP2U/5QDlQKVBpUHlQmVCpUNlQ6VD5USlROVFJUVlRaVGJUblR2VHpUflSKVKpUrlSmVLJUxlTKVNJU2lTeVOJU8lT6VP5VC
lTWVRJVFlUaVSZVMlU6VT5VSlVOVVJVWlVeVWJVZlVuVXpVflV2VYZVilWSVZZVmlWeVaJVplWqVa5VslW+VcZVylXOVOpXnd+x3
yZbVee1543nreQZ6R10DegJ6HnoUejl6N3pRes+epZlweoh2jnaTdpl2pHbedOB0LHUgniKeKJ4pniqeK54snjKeMZ42njieN545
njqePp5BnkKeRJ5GnkeeSJ5JnkueTJ5OnlGeVZ5XnlqeW55cnl6eY55mnmeeaJ5pnmqea55snnGebZ5znpJ1lHWWdaB1nXWsdaN1
s3W0dbh1xHWxdbB1w3XCddZ1zXXjdeh15nXkdet153UDdvF1/HX/dRB2AHYFdgx2F3YKdiV2GHYVdhl2G3Y8diJ2IHZAdi12MHY/
djV2Q3Y+djN2TXZedlR2XHZWdmt2b3bKf+Z6eHp5eoB6hnqIepV6pnqgeqx6qHqterN6ZIhpiHKIfYh/iIKIoojGiLeIvIjJiOKI
zojjiOWI8YgaifyI6Ij+iPCIIYkZiROJG4kKiTSJK4k2iUGJZol7iYt15YCydrR23HcSgBSAFoAcgCCAIoAlgCaAJ4ApgCiAMYAL
gDWAQ4BGgE2AUoBpgHGAg4l4mICYg5iJmIyYjZiPmJSYmpibmJ6Yn5ihmKKYpZimmE2GVIZshm6Gf4Z6hnyGe4aoho2Gi4ashp2G
p4ajhqqGk4aphraGxIa1hs6GsIa6hrGGr4bJhs+GtIbphvGG8obthvOG0IYTh96G9IbfhtiG0YYDhweH+IYIhwqHDYcJhyOHO4ce
hyWHLocahz6HSIc0hzGHKYc3hz+Hgocih32Hfod7h2CHcIdMh26Hi4dTh2OHfIdkh1mHZYeTh6+HqIfSh8aHiIeFh62Hl4eDh6uH
5Yesh7WHs4fLh9OHvYfRh8CHyofbh+qH4IfuhxaIE4j+hwqIG4ghiDmIPIg2f0J/RH9FfxCC+nr9egh7A3sEexV7Cnsrew97R3s4
eyp7GXsuezF7IHsleyR7M3s+ex57WHtae0V7dXtMe117YHtue3t7Yntye3F7kHume6d7uHuse517qHuFe6p7nHuie6t7tHvRe8F7
zHvde9p75Xvme+p7DHz+e/x7D3wWfAt8H3wqfCZ8OHxBfEB8/oEBggKCBILsgUSIIYIigiOCLYIvgiiCK4I4gjuCM4I0gj6CRIJJ
gkuCT4Jagl+CaIJ+iIWIiIjYiN+IXomdf59/p3+vf7B/sn98fEllkXydfJx8nnyifLJ8vHy9fMF8x3zMfM18yHzFfNd86Hxugqhm
v3/Of9V/5X/hf+Z/6X/uf/N/+Hx3faZ9rn1Hfpt+uJ60nnONhI2UjZGNsY1njW2NR4xJjEqRUJFOkU+RZJFikWGRcJFpkW+RfZF+
kXKRdJF5kYyRhZGQkY2RkZGikaORqpGtka6Rr5G1kbSRupFVjH6euI3rjQWOWY5pjrWNv428jbqNxI3WjdeN2o3ejc6Nz43bjcaN
7I33jfiN4435jfuN5I0Jjv2NFI4djh+OLI4ujiOOL446jkCOOY41jj2OMY5JjkGOQo5RjlKOSo5wjnaOfI5vjnSOhY6PjpSOkI6c
jp6OeIyCjIqMhYyYjJSMm2XWid6J2oncieWJ64nviT6KJotTl+mW85bvlgaXAZcIlw+XDpcqly2XMJc+l4Cfg5+Fn4afh5+In4mf
ip+Mn/6eC58Nn7mWvJa9ls6W0pa/d+CWjpKuksiSPpNqk8qTj5M+lGuUf5yCnIWchpyHnIicI3qLnI6ckJyRnJKclJyVnJqcm5ye
nJ+coJyhnKKco5ylnKacp5yonKmcq5ytnK6csJyxnLKcs5y0nLWctpy3nLqcu5y8nL2cxJzFnMacx5zKnMuczJzNnM6cz5zQnNOc
1JzVnNec2JzZnNyc3ZzfnOKcfJeFl5GXkpeUl6+Xq5ejl7KXtJexmrCat5pYnraaupq8msGawJrFmsKay5rMmtGaRZtDm0ebSZtI
m02bUZvomA2ZLplVmVSZ35rhmuaa75rrmvua7Zr5mgibD5sTmx+bI5u9nr6eO36CnoeeiJ6LnpKe1pOdnp+e257cnt2e4J7fnuKe
6Z7nnuWe6p7vniKfLJ8vnzmfN589nz6fRJ8=
`.replace(/\s+/g, '');
  /* ===== 字形参照表 结束 ===== */

  /* ============================================================
   * 3.7 字体混淆还原：把「错」的字还原成「对」的字
   * ============================================================ */

  /*
   * 3.6 只负责「认出来」，这里负责「还原」。
   *
   * 机制：超星在 DOM 里放的是生僻码位的字，再用一个内联 base64 的
   * @font-face 把这些码位的**字形**画成常用字。所以：
   *   真字 = 「这个码位在混淆字体里画出来的形状，长得像哪个常用字」
   * 于是：抠出字体 → 逐个字形渲染成位图 → 与内置参照表比汉明距离。
   *
   * 参照表（CX_FONT_* 常量，就在本节上方）由 bench/_gen-font-atlas.py 生成：
   * 6763 个 GB2312 汉字在思源黑体 Normal 下的 16×16 位图。
   * 参数是 bench 里逐个扫出来的，见生成器头部注释 —— 尤其是
   * **为什么是 16×16 而不是 12×12**（12×12 下「程」与次佳并列，靠运气）。
   *
   * **为什么必须运行时比、不能硬编码替换表**：映射每次随机 ——
   * 同一个真字在不同会话落到不同码位（实测两批：U+5AF4~U+5B0C 与
   * U+5B89~U+5BFE），任何固定表都活不过一次刷新。
   *
   * 三道闸，任何一道没过就退回 3.6 的「停手」行为 ——
   * **宁可少答一次，也不交一份错卷子**：
   *   1. 抠不到 @font-face 数据 / 字体加载失败
   *   2. 参照表解不出来
   *   3. 还原出来的字里低把握（领先量过小）的占比过高
   */

  const SF_RENDER = 96;    // 渲染字号，必须与生成参照表时一致
  const SF_RATIO = 0.25;   // 块内墨占比阈值，同上
  const SF_PIX = CX_FONT_BOX * CX_FONT_BOX;
  const SF_BYTES = (SF_PIX + 7) >> 3;
  const SF_MIN_MARGIN = 4;       // 领先量低于它就算「低把握」
  const SF_MAX_LOW_RATIO = 0.2;  // 低把握占比超过它就整体放弃
  const SF_MAX_CHARS = 1200;     // 单页待还原字符数上限（防异常页面卡死）

  const SF_POP = (function () {
    const t = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      let v = i, n = 0;
      while (v) { n += v & 1; v >>= 1; }
      t[i] = n;
    }
    return t;
  })();

  let sfSeq = 0;

  const SecretFont = {
    _table: null,        // { codes, M, N } —— 全页面只解一次
    _tableJob: null,
    _maps: null,         // WeakMap: doc -> { 码位: 真字 }
    _jobs: null,         // WeakMap: doc -> Promise（避免并发重复构建）
    _cv: null,           // WeakMap: doc -> canvas（画布必须建在字体所在的 document 里）

    _wm(which) {
      if (!this[which]) {
        try { this[which] = new WeakMap(); } catch (e) { this[which] = null; }
      }
      return this[which];
    },

    /** 解出参照表：图集 PNG → 每个候选字的打包位图。全页面只做一次。 */
    table() {
      if (this._tableJob) return this._tableJob;
      this._tableJob = new Promise((resolve, reject) => {
        let codes;
        try {
          codes = [];
          const raw = atob(CX_FONT_CODES);
          for (let i = 0; i + 1 < raw.length; i += 2) {
            codes.push(raw.charCodeAt(i) | (raw.charCodeAt(i + 1) << 8));
          }
        } catch (e) { reject(e); return; }

        const img = new Image();
        img.onload = () => {
          try {
            const cv = document.createElement('canvas');
            cv.width = img.width;
            cv.height = img.height;
            const g = cv.getContext('2d', { willReadFrequently: true });
            g.drawImage(img, 0, 0);
            const d = g.getImageData(0, 0, img.width, img.height).data;
            const W = img.width;
            const B = CX_FONT_BOX;
            const N = codes.length;
            const M = new Uint8Array(N * SF_BYTES);
            for (let i = 0; i < N; i++) {
              const oy = ((i / CX_FONT_COLS) | 0) * B;
              const ox = (i % CX_FONT_COLS) * B;
              for (let y = 0; y < B; y++) {
                const row = (oy + y) * W;
                for (let x = 0; x < B; x++) {
                  if (d[(row + ox + x) * 4] < 128) {
                    const b = y * B + x;
                    M[i * SF_BYTES + (b >> 3)] |= 1 << (7 - (b & 7));
                  }
                }
              }
            }
            this._table = { codes: codes, M: M, N: N };
            resolve(this._table);
          } catch (e) { reject(e); }
        };
        img.onerror = () => reject(new Error('参照表图集解码失败'));
        img.src = 'data:image/png;base64,' + CX_FONT_ATLAS;
      });
      return this._tableJob;
    },

    /** 从某个 document 里抠出 font-cxsecret 的 base64 字体数据 */
    fontData(doc) {
      const isTarget = (f) =>
        String(f || '').replace(/['"]/g, '').trim().toLowerCase() === 'font-cxsecret';

      let sheets = [];
      try { sheets = Array.from(doc.styleSheets || []); } catch (e) { sheets = []; }
      for (const ss of sheets) {
        let rules = [];
        try { rules = Array.from(ss.cssRules || []); } catch (e) { continue; }
        for (const r of rules) {
          if (!r || r.type !== 5) continue;             // 5 = CSSFontFaceRule
          if (!isTarget(r.style && r.style.fontFamily)) continue;
          const m = /base64,([A-Za-z0-9+/=]+)/.exec(String((r.style && r.style.src) || ''));
          if (m) return m[1];
        }
      }

      // 样式表读不到时的兜底：直接翻内联 <style> 原文
      let styles = [];
      try { styles = Array.from(doc.querySelectorAll('style')); } catch (e) { styles = []; }
      for (const st of styles) {
        const t = st.textContent || '';
        if (t.indexOf('font-cxsecret') < 0) continue;
        const m = /font-cxsecret[^}]*?base64,([A-Za-z0-9+/=]+)/.exec(t);
        if (m) return m[1];
      }
      return null;
    },

    /** 把 ch 用指定字体渲染成 16×16 位图（SF_BYTES 字节，行优先高位在前） */
    render(doc, family, ch) {
      const S = SF_RENDER;
      const B = CX_FONT_BOX;
      const cvs = this._wm('_cv');
      let cv = cvs && cvs.get(doc);
      if (!cv) {
        cv = doc.createElement('canvas');
        if (cvs) cvs.set(doc, cv);
      }
      cv.width = S * 2;
      cv.height = S * 2;
      const g = cv.getContext('2d', { willReadFrequently: true });
      g.fillStyle = '#fff';
      g.fillRect(0, 0, cv.width, cv.height);
      g.fillStyle = '#000';
      g.font = S + 'px ' + family;
      g.textBaseline = 'top';
      g.fillText(ch, S / 2, S / 2);

      const W = cv.width, H = cv.height;
      const d = g.getImageData(0, 0, W, H).data;
      let x0 = W, y0 = H, x1 = -1, y1 = -1;
      for (let y = 0; y < H; y++) {
        const row = y * W * 4;
        for (let x = 0; x < W; x++) {
          if (d[row + x * 4] < 128) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
      }
      if (x1 < 0) return null;                 // 空白字形

      const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
      const out = new Uint8Array(SF_BYTES);
      for (let by = 0; by < B; by++) {
        const sy0 = y0 + Math.floor(by * bh / B);
        let sy1 = y0 + Math.floor((by + 1) * bh / B);
        if (sy1 <= sy0) sy1 = sy0 + 1;
        for (let bx = 0; bx < B; bx++) {
          const sx0 = x0 + Math.floor(bx * bw / B);
          let sx1 = x0 + Math.floor((bx + 1) * bw / B);
          if (sx1 <= sx0) sx1 = sx0 + 1;
          let ink = 0, n = 0;
          for (let y = sy0; y < sy1; y++) {
            const row = y * W * 4;
            for (let x = sx0; x < sx1; x++) {
              if (d[row + x * 4] < 128) ink++;
              n++;
            }
          }
          if (n && ink / n >= SF_RATIO) {
            const b = by * B + bx;
            out[b >> 3] |= 1 << (7 - (b & 7));
          }
        }
      }
      return out;
    },

    /** 在参照表里找最像的字（返回索引 / 距离 / 领先量） */
    match(q, table) {
      const B = SF_BYTES;
      const M = table.M;
      let best = -1, bd = 1 << 30, sd = 1 << 30;
      for (let i = 0, N = table.N; i < N; i++) {
        let dist = 0;
        const off = i * B;
        for (let k = 0; k < B; k++) dist += SF_POP[(q[k] ^ M[off + k]) & 0xff];
        if (dist < bd) { sd = bd; bd = dist; best = i; }
        else if (dist < sd) sd = dist;
      }
      return { index: best, dist: bd, margin: sd - bd };
    },

    /**
     * 为某个 document 建立「码位 → 真字」映射。
     * 按 document 缓存（Promise 也缓存，避免并发重复跑一遍几秒的匹配）。
     * @returns {Promise<object|null>} 失败返回 null
     */
    build(doc) {
      const jobs = this._wm('_jobs');
      if (!jobs) return Promise.resolve(null);
      const cached = jobs.get(doc);
      if (cached) return cached;
      const job = this._build(doc).catch((e) => {
        log('  字体还原失败：', (e && e.message) || e);
        return null;
      });
      jobs.set(doc, job);
      return job;
    },

    async _build(doc) {
      const b64 = this.fontData(doc);
      if (!b64) {
        log('  · 没找到 font-cxsecret 的 @font-face 数据，无法还原');
        return null;
      }

      const win = doc.defaultView || window;
      const family = '__cx_probe_' + (++sfSeq);
      try {
        const face = new win.FontFace(
          family, 'url(data:font/ttf;base64,' + b64 + ') format("truetype")');
        await face.load();
        doc.fonts.add(face);
      } catch (e) {
        log('  · 混淆字体加载失败：', (e && e.message) || e);
        return null;
      }

      const table = await this.table();

      // 待还原的字符：font-cxsecret 元素里的所有非 ASCII 字符
      const seen = Object.create(null);
      const list = [];
      let nodes = [];
      try { nodes = Array.from(doc.querySelectorAll('[class*="font-cxsecret"]')); }
      catch (e) { nodes = []; }
      for (const n of nodes) {
        const t = n.textContent || '';
        for (const ch of t) {
          const cp = ch.codePointAt(0);
          if (cp < 0x80 || seen[cp]) continue;
          seen[cp] = 1;
          list.push(ch);
          if (list.length > SF_MAX_CHARS) break;
        }
        if (list.length > SF_MAX_CHARS) break;
      }
      if (!list.length) {
        log('  · 混淆元素里没抓到汉字，无法还原');
        return null;
      }

      const quoted = '"' + family + '", sans-serif';
      const map = Object.create(null);
      const lows = [];
      let replaced = 0;

      for (const ch of list) {
        /*
         * 先判断这个字**是否真被替换过**：
         * 拿「混淆字体 + 兜底」与「纯兜底」两次渲染对比。
         * 没被替换的字（混淆字体里没有它的字形）两次结果完全一致 —— 原样保留。
         * 不做这一步的话，普通字也会被拿去查表，查出一个形状相近的错字。
         */
        const a = this.render(doc, quoted, ch);
        const b = this.render(doc, 'sans-serif', ch);
        if (!a || !b) continue;
        let same = true;
        for (let i = 0; i < SF_BYTES; i++) {
          if (a[i] !== b[i]) { same = false; break; }
        }
        if (same) continue;

        const hit = this.match(a, table);
        if (hit.index < 0) continue;
        const real = String.fromCharCode(table.codes[hit.index]);
        if (real === ch) continue;                    // 形状没变，不必替换
        map[ch.codePointAt(0)] = real;
        replaced++;
        if (hit.margin <= SF_MIN_MARGIN) {
          lows.push(ch + '→' + real + '（领先 ' + hit.margin + '）');
        }
      }

      if (!replaced) {
        log('  · 一个被替换的字都没认出来，判定为误判或结构变了');
        return null;
      }

      const lowRatio = lows.length / replaced;
      if (lowRatio > SF_MAX_LOW_RATIO) {
        warn('  · 还原出来的字里低把握的太多（' + lows.length + '/' + replaced +
             '），不敢拿来答题');
        log('    样例：' + lows.slice(0, 6).join('、'));
        return null;
      }

      const maps = this._wm('_maps');
      if (maps) maps.set(doc, map);

      log('  · 已还原 ' + replaced + ' 个被替换的字（共扫描 ' + list.length +
          ' 个，低把握 ' + lows.length + ' 个）');
      if (lows.length) log('    低把握样例：' + lows.slice(0, 6).join('、'));
      return map;
    },

    /** 用某个 document 的映射还原文本（没有映射时原样返回） */
    decode(doc, text) {
      if (!text) return text;
      const maps = this._maps;
      if (!maps) return text;
      let map = null;
      try { map = maps.get(doc); } catch (e) { return text; }
      if (!map) return text;
      let out = '';
      for (const ch of text) out += map[ch.codePointAt(0)] || ch;
      return out;
    },
  };

  /*
   * 每题旁边的 AI 作答进度徽标。
   *
   * 为什么要有：答题是「抓题 → 请求 API（可能几十秒）→ 回填」的异步流程，
   * 中间那段等待在页面上**完全静默** —— 题目摆在那儿一动不动，
   * 用户只能反复点诊断。把状态直接标在题目旁边，等待才有形状。
   *
   * 三条硬约束，少一条就会出问题：
   *
   *  1) **徽标不能匹配 Q_SELECTORS 里的任何选择器。**
   *     一旦被 collect() 当成题干或选项，轻则题目内容被污染，
   *     重则 sig 每次都变 → handled 去重失效 → 反复请求同一批题。
   *     所以用**无 class 的 div**：Q_SELECTORS 里没有裸 `div`，
   *     option 全是带 class 的选择器，blank 只认 contenteditable 的 div。
   *
   *  2) **插在容器最前面**，不依赖页面任何定位样式（position:relative 未必存在）。
   *
   *  3) **inline style 全部 setProperty(important)**，
   *     否则超星的全局 CSS（比如 `.TiMu div{display:none}`）能把它盖掉。
   */
  const QProgress = {
    ATTR: 'data-cx-progress',

    // 状态 → 配色。页面是浅色的，所以用浅底深字。
    STYLE: {
      asking: { bg: '#e8f1ff', fg: '#1a6fd4', bd: '#b8d4f7' },
      ok: { bg: '#e8f8ee', fg: '#17914a', bd: '#b3e3c5' },
      fail: { bg: '#fdecec', fg: '#cf1322', bd: '#f7c0c0' },
      none: { bg: '#fff7e6', fg: '#b26a00', bd: '#ffd591' },
    },

    /** 取到（必要时创建）某道题容器上的徽标元素 */
    badge(el) {
      try {
        let b = el.querySelector('[' + QProgress.ATTR + ']');
        if (b) return b;
        const doc = el.ownerDocument || document;
        b = doc.createElement('div');
        b.setAttribute(QProgress.ATTR, '1');
        el.insertBefore(b, el.firstChild);
        return b;
      } catch (e) { return null; }
    },

    /**
     * 设置某道题的进度。
     * @param {Element} el    题目容器
     * @param {string} state  'asking' | 'ok' | 'fail' | 'none'
     * @param {string} text   显示文案
     */
    set(el, state, text) {
      const b = this.badge(el);
      if (!b) return;
      const s = this.STYLE[state] || this.STYLE.asking;
      const st = b.style;
      const put = (k, v) => { try { st.setProperty(k, v, 'important'); } catch (e) { /* 忽略 */ } };
      put('display', 'inline-block');
      put('margin', '0 0 6px 0');
      put('padding', '1px 10px');
      put('border-radius', '10px');
      put('border', '1px solid ' + s.bd);
      put('background', s.bg);
      put('color', s.fg);
      put('font-size', '12px');
      put('line-height', '18px');
      put('font-family', 'system-ui,-apple-system,"Microsoft YaHei",sans-serif');
      put('font-weight', '600');
      put('white-space', 'nowrap');
      put('user-select', 'none');
      put('pointer-events', 'none');   // 别挡住题目本身的点击
      b.textContent = text;
    },

    /** 清掉某道题的徽标 */
    clear(el) {
      try {
        const b = el.querySelector('[' + QProgress.ATTR + ']');
        if (b) b.remove();
      } catch (e) { /* 忽略 */ }
    },

    /** 清掉当前文档里所有徽标（关闭功能时用） */
    clearAll() {
      try {
        document.querySelectorAll('[' + QProgress.ATTR + ']').forEach((n) => n.remove());
      } catch (e) { /* 忽略 */ }
      try {
        const root = questionRoot();
        if (root && root !== document) root.querySelectorAll('[' + QProgress.ATTR + ']').forEach((n) => n.remove());
      } catch (e) { /* 忽略 */ }
    },
  };

  /**
   * 把一道题**实际解析出来的样子**打印成一行。
   *
   * 存在的理由：脚本对超星页面的全部假设都压在 Q_SELECTORS 上，一旦对不上，
   * 症状是"回填失败"——而这句话完全无法定位问题：是没抓到选项？字母对不上？
   * 还是题型判错了？用户只能猜。
   *
   * 这里把结论直接摊开：题型、解析出几个选项、字母到元素的映射、填空元素数。
   * 有它，「回填失败」就从一句抱怨变成一条可核对的证据。
   */
  function describeQuestion(q) {
    if (!q) return '(题目对象为空)';
    const opts = q.options || [];
    const byKey = q.optionByKey || {};
    const allEls = q.allOptionEls || q.optionEls || [];

    const optTxt = opts.length
      ? opts.map((o) => `${o.key}=${String(o.text || '').replace(/\s+/g, ' ').slice(0, 18)}`).join(' | ')
      : '(未解析出任何选项)';

    // 哪些字母是有元素的 —— 这一项直接暴露"字母取不到元素"的错位
    const mapped = Object.keys(byKey).sort().join('');
    const letters = opts.map((o) => String(o.key).toUpperCase()).sort().join('');

    return `第${(q.index ?? 0) + 1}题 [${q.type}] 选项${opts.length}个/元素${allEls.length}个` +
           `${letters ? ` 字母=${letters}` : ''}` +
           `${mapped && mapped !== letters ? ` ⚠映射=${mapped}(与字母不一致)` : ''}` +
           ` 填空元素=${(q.blankEls || []).length}` +
           ` 题干="${String(q.question || '').slice(0, 30)}"` +
           `${opts.length ? `\n      选项明细: ${optTxt}` : ''}`;
  }

  const WorkModule = {
    running: false,       // 一次 loop() 正在执行（诊断用：区分"正在请求"和"循环已死"）
    watching: false,      // 观察循环是否活着。**不要用 timer 判断**，见 watch() 的说明
    handled: new Set(),   // 已处理的题目签名，防止重复请求
    qTries: new Map(),    // 签名 → 已尝试次数（逐题模式用来给"重试"封顶）
    timer: null,          // 下一次观察的定时器
    wait: 0,              // 下一次观察的间隔
    failStreak: 0,        // 连续"一个答案都没填上"的次数
    lastApi: '',          // 最近一次答题请求的结果，诊断用
    /*
     * 正在进行的请求。null 表示当前没有请求在飞。
     * 存在的唯一理由：让「请求中」这三个字**带上时间**。
     * 否则用户看到「请求中」只能干等，既不知道发到哪、第几次，也不知道等了多久 ——
     * 而这三种信息恰好决定了"该继续等"还是"该去改配置"。
     */
    req: null,

    /*
     * 本任务点是否已完成。
     *
     * 一旦确认，**再也不作答** —— 原因不只是浪费接口额度：
     * 任务点完成后再去填、再点提交，有可能**覆盖掉已经交上去的答案**。
     * 那比"少答一题"严重得多，而且用户根本不会发现。
     *
     * 只在拿到**正向证据**时才置位（见 doneReason）。判不出来就当未完成 ——
     * 反过来错的代价更大：该答的时候不答，用户的作业就真的空着了。
     */
    done: false,
    doneWhy: '',
    catalogSkipped: false,   // 只是用来"状态变化时提示一次"，不参与判断

    /*
     * 本任务点的题目是否被超星的字体混淆保护（见 detectFontObfuscation）。
     * 置位后**本轮不再作答、也绝不提交** —— 文本本身就是错的，
     * 交一份错卷子比什么都不做更糟（章节测验往往只允许提交一次）。
     */
    obfuscated: false,
    obfChecked: false,       // 检测只做一次（样式兜底那层很贵），这里记"做过了"

    /*
     * 所有对外答题请求的统一入口，只为了记录"在飞"的状态。
     * 包一层而不是各处直接调 request()，是为了保证不会有哪条路径漏掉上报。
     */
    async callApi(label, url, opts, retry) {
      const total = (retry == null ? 2 : retry) + 1;
      const timeout = opts.timeout || 30000;
      this.req = {
        label,
        url: redactUrl(url),
        attempt: 1,
        total,
        startedAt: Date.now(),
        attemptStartedAt: Date.now(),
        timeout,
      };
      try {
        return await request(opts, {
          retry: total - 1,
          onAttempt: (i) => {
            if (!this.req) return;
            this.req.attempt = i + 1;
            this.req.attemptStartedAt = Date.now();
          },
        });
      } finally {
        this.req = null;
      }
    },

    /*
     * 把 HTTP/网络错误翻译成"用户下一步该做什么"。
     *
     * 原来的输出是 `答题 API 调用失败: HTTP 401 {...}` —— 对开发者够用，
     * 但用户看到这行只会来问"什么意思"。诊断信息的价值在于**导向行动**，
     * 所以每种错误都附上一句可执行的建议。
     */
    explainApiError(e, url) {
      const msg = String((e && e.message) || e || '');
      const at = redactUrl(url);
      const keyState = CONFIG.apiKey
        ? `已填（${String(CONFIG.apiKey).length} 字符）`
        : '**未填**';

      if (/^HTTP 401|^HTTP 403/.test(msg)) {
        return `${msg} —— 鉴权被拒（地址 ${at}，密钥${keyState}）。去面板确认密钥没填错、没过期、没多带空格。`;
      }
      if (/^HTTP 404/.test(msg)) {
        return `${msg} —— 地址不存在（${at}）。多数是少填或多填了 /chat/completions，检查面板的「地址已是完整路径」勾选状态。`;
      }
      if (/^HTTP 429/.test(msg)) {
        return `${msg} —— 触发限流或余额不足（${at}）。等一会儿再试，或去服务商后台看额度。`;
      }
      if (/^HTTP 5\d\d/.test(msg)) {
        return `${msg} —— 服务端错误（${at}）。这是对方的问题，稍后会自动重试。`;
      }
      if (/超时/.test(msg)) {
        return `${msg}（${at}，单次上限 ${Math.round((CONFIG.apiTimeout || 30000) / 1000)}s）。超时不重试 —— 通常是地址不可达、被墙，或模型太慢。先用「测试 API」验证连通性。`;
      }
      if (/网络错误/.test(msg)) {
        return `${msg}（${at}）。检查网络，或该域名是否需要代理。`;
      }
      return `${msg}（${at}）`;
    },

    /* ---------- 完成判定：已完成的任务点不再作答 ---------- */

    /*
     * 「本任务点已点过提交」记录的有效期。
     *
     * 记录是按**任务点**存的，所以正常不会串到别的任务点；这个上限只是兜底：
     * 万一 taskKey() 在某次超星改版后认错了，也不至于把一整门课永久拦住。
     * 2 小时足够覆盖"提交完顺手再点开看一眼"这种最常见的复查场景。
     * 想立刻重来：面板点「重新执行」，它会把这个记录一起清掉。
     */
    SUBMIT_LATCH_TTL: 2 * 60 * 60 * 1000,

    /**
     * 本任务点"已经点过提交"的持久记录；没有 / 不是本任务点 / 已过期 → null。
     *
     * 这是完成判定的**第三道**，专门兜住"页面上什么都看不出来"的情况：
     * 提交后 iframe 被重载、或者结果页把题目原样留着却没有完成字样。
     * 这两种情况下前两道都会失效，脚本于是把交过的卷子重答一遍。
     */
    submitLatch() {
      const key = taskKey();
      if (!key) return null;      // 认不出任务点 → 不加闸门（宁可多答一次）
      let s = null;
      try { s = GM_getValue(EVT_SUBMITTED, null); } catch (e) { return null; }
      if (!s || s.key !== key) return null;
      if (Date.now() - (s.at || 0) > this.SUBMIT_LATCH_TTL) return null;
      return s;
    },

    /**
     * 记下"本任务点点了提交"。
     *
     * **必须在 `btn.click()` 之前调** —— 点完页面可能立刻跳走，之后就来不及写了。
     * 代价是"点了但没提交成功"也会留下记录，所以记录带 `confirmed` 标记，
     * 诊断里能看出是哪一种；用户也可以用「重新执行」清掉。
     *
     * 为什么这个代价可以接受：submit() 只在**所有题都答上了**才会被调用，
     * 此时答案已经在页面上。就算提交其实没成功，脚本停下来也不会让卷子变空 ——
     * 而反过来的错误（重答 + 重交）会覆盖掉已经交上去的答案，严重得多。
     */
    markSubmitTried() {
      const key = taskKey();
      if (!key) return false;
      try {
        GM_setValue(EVT_SUBMITTED, { key, at: Date.now(), confirmed: false });
        return true;
      } catch (e) { return false; }
    },

    /** 拿到提交成功确认：把记录升级成"已确认"（时间戳保持首次点击那一刻） */
    confirmSubmitLatch() {
      const key = taskKey();
      if (!key) return;
      try {
        const s = GM_getValue(EVT_SUBMITTED, null);
        if (s && s.key === key) GM_setValue(EVT_SUBMITTED, { key, at: s.at, confirmed: true });
      } catch (e) { /* 忽略 */ }
    },

    /**
     * 清掉提交记录 —— 只在用户手动点「重新执行」时调用。
     *
     * **无条件清，不比对 key**：这个动作会广播给所有 frame，
     * 而顶层 frame 的 taskKey() 和干活的那个 iframe 根本不是同一个，
     * 比对 key 的话永远清不掉。
     */
    clearSubmitLatch() {
      try { GM_setValue(EVT_SUBMITTED, null); } catch (e) { /* 忽略 */ }
    },

    /**
     * 本 frame 里有没有"这个任务点已经交过了"的**正向证据**。
     *
     * 只看正向证据，不看"缺少什么"：比如"找不到提交按钮"就不能当依据 ——
     * 题目还没渲染出来时同样找不到，那会把正常流程误判成已完成。
     * 判不出来的代价是"多答一次"，误判的代价是"该答的没答"，后者严重得多。
     */
    doneReason() {
      if (this.done) return this.doneWhy;

      // 1) 超星自己渲染的完成标记 —— 项目里最权威的信号
      try { if (Completeness.markFound()) return '页面出现任务点完成标记'; } catch (e) { /* 忽略 */ }

      // 2) 页面上明确写着"已提交/已完成"
      try {
        const why = this.submittedEvidence();
        if (why) return why;
      } catch (e) { /* 忽略 */ }

      /*
       * 3) 我们自己点过提交（跨 frame 重载 / 页面重渲染都还在）。
       *
       * 放在最后：前两道能给出更精确的"依据"描述，只有它们都失效时
       * 才退回这条"我记得我交过"。这条存在的意义就是兜住那两种情况。
       */
      const latch = this.submitLatch();
      if (latch) {
        const mins = Math.max(1, Math.round((Date.now() - (latch.at || 0)) / 60000));
        return latch.confirmed
          ? `本任务点已提交（${mins} 分钟前，已收到成功确认）`
          : `本任务点已点过提交、未收到成功确认（${mins} 分钟前）`;
      }

      return '';
    },

    /** 页面上"已经交过"的文字证据 */
    submittedEvidence() {
      const root = questionRoot() || document;

      // 提交成功提示框 / 完成提示
      const banners = '.layui-layer-content, .jw_btn_confirm, #popok, .popup_content, .completeTip, .mark_done';
      for (const sel of banners.split(',')) {
        let n = null;
        try { n = root.querySelector(sel.trim()); } catch (e) { continue; }
        if (n && /已完成|已提交|交卷成功|提交成功/.test(n.textContent || '')) {
          return `页面提示「${(n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 20)}」`;
        }
      }

      /*
       * 提交按钮的文案变成"已提交/已完成"也是正向证据。
       * 这里刻意**不用**"按钮被禁用"作依据 —— 有些题型在所有题答完前一直是禁用的，
       * 拿它当完成证据会让脚本该答的时候不答。
       */
      for (const sel of Q_SELECTORS.submit) {
        let list = [];
        try { list = Array.from(root.querySelectorAll(sel)); } catch (e) { continue; }
        for (const n of list) {
          const t = (n.textContent || '').replace(/\s+/g, ' ').trim();
          if (/^(已提交|已完成|已交卷|已交|提交成功)$/.test(t)) return `提交按钮显示「${t}」`;
        }
      }
      return '';
    },

    /**
     * 顶层广播的目录状态：当前章节在目录里是否已经打了完成标记。
     *
     * **不 latch。** 顶层随时可能切到别的章节，这个值会变；
     * 一旦缓存住，用户换到新任务点后脚本就再也不答了。
     * 所以每轮现读，并带 5 分钟新鲜度限制（顶层关掉了就自然失效）。
     */
    chapterDoneByCatalog() {
      try {
        const s = GM_getValue(EVT_CHAPTER_DONE, null);
        return !!(s && s.done && Date.now() - (s.at || 0) < 300000);
      } catch (e) { return false; }
    },

    /** 确认完成：幂等，只记第一次的原因 */
    markDone(why) {
      if (this.done) return;
      this.done = true;
      this.doneWhy = why || '任务点已完成';
      log(`任务点已完成（${this.doneWhy}），停止作答 —— 不再请求接口，也不会提交`);
      // 清掉残留徽标：任务已经结束了，页面上还挂着"AI 作答中…"会让人以为脚本还在跑
      try { QProgress.clearAll(); } catch (e) { /* 忽略 */ }
    },

    start() {
      if (!CONFIG.answerEnabled) {
        // 这句要留：用户看到"无反应"时，最想确认的就是"到底有没有启动"
        log('答题功能未启用，跳过（面板 → 答题 → 启用）');
        return;
      }
      log('答题模块启动，开始观察题目…');
      this.watch();
    },

    /*
     * 持续观察题目，而不是"等一次，等不到就算了"。
     *
     * v1.4.0 之前这里只等一次（waitFor 25 秒），超时就 log 一句永久返回，
     * 而且没有任何重试入口。章节测验页恰恰经常是这种情况：
     *   - 先显示「开始答题 / 继续答题」按钮，点了才渲染题目
     *   - 题目通过异步接口拉取，网络慢时超过 25 秒
     *   - 先弹「你有未提交的作答记录」确认框
     * 于是脚本一动不动，用户看到的就是"切到测验页脚本无反应"。
     *
     * 现在：只要这个 frame 还活着就一直观察。有题就处理，处理完继续看
     * （应对"做完一页翻下一页"的分页答题）。没题就指数退避到 8 秒一次，
     * 开销可以忽略 —— 比超星自己轮询接口的频率低得多。
     *
     * ⚠️ 为什么要有独立的 watching 标志，而不是用 `!!this.timer` 判断"在不在观察"：
     * tick 是 async 的，执行期间 this.timer 一定是 null（它只在 tick 的**末尾**重新赋值）。
     * 所以"timer 为空"同时意味着"循环已死"和"正在请求中"两件完全不同的事 ——
     * 用 timer 做诊断会得出"这是个 bug"的错误结论（v1.4.2 就踩了这个坑）。
     */
    watch() {
      if (this.watching) return;
      this.watching = true;
      this.wait = 1500;

      const tick = async () => {
        this.timer = null;
        if (!this.watching) return;
        try {
          if (!CONFIG.answerEnabled) {
            // 开关被关掉了：不干活，但保持循环活着，等它被重新打开
            this.wait = 8000;
            return;
          }

          /*
           * 任务点已完成 → 不再作答。
           *
           * 这一条以前**完全没有**，所以已经做完的任务点会被反复作答；
           * 如果开着自动提交，还会把已经交上去的答案覆盖掉。
           * 这里只是"少干活"的优化，真正的判定在 loop() 里也有一道。
           */
          const why = this.doneReason();
          if (why) { this.markDone(why); this.wait = 30000; return; }
          if (this.chapterDoneByCatalog()) {
            if (!this.catalogSkipped) {
              this.catalogSkipped = true;
              log('目录里当前章节已完成，暂停作答（切到未完成的任务点会自动恢复）');
            }
            this.wait = 30000;
            return;
          }
          this.catalogSkipped = false;

          const n = this.findContainers().length;
          if (n > 0) {
            /*
             * 命中后先停一下再抓。
             * 超星是一道一道往 DOM 里塞的，看到第一道就立刻 collect() 会抓到
             * 只有一道题的半成品，然后把剩下那些当成"没答案"跳过去。
             */
            await sleep(1000);
            const r = this.findContainers().length > 0 ? await this.loop() : 'idle';
            this.wait = watchDelay(this.wait, r);
          } else {
            this.wait = watchDelay(this.wait, 'idle');
          }
        } catch (e) {
          /*
           * 观察循环是长期跑着的，**一次异常绝不能把它整个杀死**。
           * 原实现没有这层保护：tick 里任何一处抛异常，末尾的重新排期就不会执行，
           * 循环永久停摆，而且没有任何提示 —— 表现就是"脚本无反应"。
           */
          warn('观察循环异常（已忽略，继续观察）:', e.message || e);
          this.wait = 8000;
        } finally {
          if (this.watching) this.timer = Timers.after(tick, this.wait);
        }
      };

      this.timer = Timers.after(tick, 1200);
    },

    stop() {
      this.watching = false;
      if (this.timer) { Timers.clear(this.timer); this.timer = null; }
    },

    /** 由「重新执行」触发：停掉当前观察，重新来一遍 */
    restart() {
      this.stop();
      this.wait = 0;
      this.failStreak = 0;
      this.lastApi = '';
      /*
       * 重新执行是手动覆盖：清掉"已完成"的缓存，让 watch 重新判定一次。
       * 证据还在的话下一轮会立刻重新置位 —— 所以手动点一下**不会**让脚本
       * 又开始答已经交过的卷子。
       */
      this.done = false;
      this.doneWhy = '';
      this.catalogSkipped = false;
      /*
       * 字体混淆的判定也重来一次。
       *
       * 这是**唯一**能清掉这道闸门的地方 —— 否则万一是误判，脚本就永久停手了，
       * 而用户唯一的自救手段就是点「重新执行」。所以它必须在这里被重置。
       */
      this.obfuscated = false;
      this.obfChecked = false;
      if (CONFIG.answerEnabled) this.watch();
    },

    /**
     * 超星的字体混淆检测 + 还原（见 detectFontObfuscation / SecretFont）。
     *
     * 分两步：
     *   1. **认出来** —— 命中就把题目文本标为不可信；
     *   2. **还原** —— 认出之后先试着用字形比对把真字解回来（SecretFont.build）。
     *      解成功就照常答题；解不出来才停手。
     *
     * 停手是最后手段：题目文本本身就是错的，后面抓题、请求、回填、提交全部白做，
     * 而且必须赶在 submit() 之前 —— 这份卷子一个字都不该交。
     *
     * 检测只做一次：样式兜底那层要对题目子树逐个 getComputedStyle，很贵，
     * 放进每轮观察里就成了"回到 v1.0.0 卡顿老路"的那种开销。
     * （还原本身也有缓存，见 SecretFont.build。）
     *
     * @returns {Promise<boolean>} true = 命中且还原不了，本轮不要继续
     */
    async checkFontObfuscation() {
      if (this.obfuscated) return true;
      if (this.obfChecked) return false;
      this.obfChecked = true;

      let hit = false;
      try { hit = detectFontObfuscation(questionRoot() || document); } catch (e) { hit = false; }
      if (!hit) {
        try { hit = fontObfuscationByStyle(this.findContainers()); } catch (e) { hit = false; }
      }
      if (!hit) return false;

      /*
       * 认出来了 —— 先试还原。
       *
       * 这一步可能要点时间（渲染上百个字形 × 6763 个候选比距离），
       * 但它只在每个 frame 的第一次跑，且结果按 document 缓存。
       */
      const doc = questionRoot() || document;
      log('检测到字体混淆（font-cxsecret），尝试用字形比对还原文本…');
      let restored = null;
      try { restored = await SecretFont.build(doc); } catch (e) { restored = null; }
      if (restored) {
        this.lastApi = '字体混淆已还原，继续作答';
        return false;
      }

      this.obfuscated = true;
      this.lastApi = '已停止作答：题目被字体混淆（font-cxsecret），文本不可用';

      /*
       * 这里必须把话说透 —— 用户看到"脚本不答题了"的第一反应是脚本坏了，
       * 而真实情况是脚本**主动**停手，且这个决定是对的。
       */
      warn('本页题目被超星的字体混淆保护（font-cxsecret）—— 抓到的题干和选项都是乱码，' +
           '而且这次没能还原出原文。');
      log('  · 超星在 DOM 里放的是"错"的字，靠自定义字体把它渲染成"对"的字：');
      log('    人眼看页面完全正常，但 textContent / 复制粘贴 / 抓取拿到的全是错的。');
      log('  · 实测：页面文本「增强寕患意识，是中国共寍党」，真实文本「增强忧患意识，是中国共产党」。');
      log('  · 还原用的是字形比对（见日志里上一段"字体还原"的结果），失败原因通常是');
      log('    字体数据抠不到、字体加载失败、或认出来的字里低把握的太多。');
      log('  · 已停止作答，**并且不会提交**：交一份错卷子比不交更糟（章节测验往往只能提交一次）。');
      return true;
    },

    /**
     * 跑一轮：抓题 → 请求 → 回填 →（满足条件时）提交。
     * @returns {'ok'|'idle'|'failed'}
     */
    async loop() {
      if (this.running) return 'idle';

      /*
       * 任务点已经完成 → 直接不跑。
       *
       * watch() 里已经拦了一道，这里是第二道 —— 因为 loop() 还可能被
       * 「重新执行」或别的路径直接调到。缺了这道，任何一个新入口都会
       * 绕过"已完成就不再答"的保护。
       */
      const why = this.doneReason();
      if (why) { this.markDone(why); return 'idle'; }
      if (this.chapterDoneByCatalog()) return 'idle';

      /*
       * 字体混淆 → 先尝试还原；还原不了才停手。放在最前面，因为题目文本
       * 本身就是错的，后面的抓题/请求/回填/提交全是白做，
       * 而且必须赶在 submit() 之前。
       */
      if (await this.checkFontObfuscation()) return 'idle';

      this.running = true;
      try {
        const questions = this.collect();
        if (!questions.length) return 'idle';

        const fresh = questions.filter((q) => !this.handled.has(q.sig));
        if (!fresh.length) return 'idle';   // 已处理过，安静跳过（观察是常态，别刷屏）

        const total = fresh.length;
        log(`抓到 ${total} 道新题，共 ${questions.length} 道`);

        let filled;
        if (CONFIG.answerMode === 'batch') {
          /*
           * 整卷一次：所有题打包发一个请求。
           * 请求前先把进度打到页面上 —— 接下来是几十秒的往返，期间页面完全静默，
           * 徽标是用户唯一能看到的"脚本还活着"的证据。
           */
          this.markProgress(fresh, 'asking', 'AI 作答中…');
          const answers = await this.askApi(fresh);
          filled = CONFIG.dryRun
            ? fresh.filter((q) => this.applyOne(q, answers[q.id])).length
            : this.fill(fresh, answers, { keepFailedUnhandled: true });
        } else {
          filled = await this.answerOneByOne(fresh);
        }

        /*
         * 演练模式到这里就结束 —— **不提交**。
         *
         * 必须放在提交判定之前：下面的"没答上就不提交"会打出一堆告警，
         * 而演练模式下页面根本没被改动，"没答上"是预期内的，那些告警只会误导。
         */
        if (CONFIG.dryRun) {
          this.lastApi = `演练完成：${filled}/${total} 题能找到对应元素（未提交）`;
          log(`[演练] 本轮结束：${filled}/${total} 题能落到元素上。` +
              '演练模式不点击、不提交 —— 把上面的 [演练] 日志发出来即可定位选择器问题。');
          return 'idle';
        }

        /*
         * 一个答案都没填上 → 绝不提交。
         *
         * 原实现不管填了几题都往下走，于是 API 挂掉时脚本会**提交一张白卷**。
         * 那比"什么都不做"更糟：白卷会占掉一次作答机会，而很多章节测验不允许重做。
         */
        if (!filled) {
          this.failStreak++;
          this.lastApi = `失败：0 题回填（连续 ${this.failStreak} 次）`;
          warn('一个答案都没填上，**不提交**。' +
               (this.failStreak >= 3
                 ? '已连续多次失败，点面板「测试 API」检查地址和密钥。'
                 : '稍后会自动重试。'));
          return 'failed';
        }

        this.failStreak = 0;

        /*
         * 只答上了一部分 → 同样不提交。
         *
         * "不交白卷"这条原则要往前再走一步：**缺答案的卷子一样不能交**。
         * 章节测验通常只允许提交一次，一道空题就是白丢分，而且用户不一定
         * 注意到 —— 徽标上写着"未作答"，但提交按钮是脚本点的，人就走了。
         *
         * 没答上的题交给下一轮观察重试（失败时不记入 handled，所以还会被捞起来）；
         * 重试到上限仍失败的会被标成"已放弃"，那时仍然不提交，让用户自己决定。
         */
        if (filled < total) {
          const pending = fresh.filter((q) => !this.elFilled(q));
          pending.forEach((q) => this.retryLater(q, '未答上'));
          const waiting = pending.filter((q) => !this.handled.has(q.sig)).length;

          this.lastApi = `部分完成：${filled}/${total} 题`;
          if (waiting) {
            warn(`只答上 ${filled}/${total} 道，还有 ${waiting} 道没答上，**先不提交** —— ` +
                 '缺答案的卷子交上去会直接算错。脚本稍后会自动重试这几道。');
          } else {
            warn(`只答上 ${filled}/${total} 道，其余已重试到上限，**先不提交**。` +
                 '看题目旁边的红色标记，手动补上再提交。');
          }
          return 'failed';
        }

        this.lastApi = `成功：回填 ${filled}/${total} 题`;

        if (CONFIG.autoSubmit) {
          await sleep(CONFIG.submitDelay);
          await this.submit();
        }
        return 'ok';
      } catch (e) {
        warn('答题流程异常:', e.message || e);
        this.lastApi = '异常：' + (e.message || e);
        return 'failed';
      } finally {
        this.running = false;
      }
    },

    /*
     * 逐题作答：一次请求只发一道题，拿到答案**立刻回填**，再问下一道。
     *
     * 相比"整卷一次"，换来三件事：
     *   1) 进度可见 —— 每道题各自从「作答中」变成「已作答」，
     *      而不是整卷一起干等一个长请求；
     *   2) 失败不连坐 —— 某道题模型答不出来，不影响其它题照常作答；
     *   3) 重试成本低 —— 只需要重发失败的那一道，不用把整卷再发一遍。
     *
     * 代价是 N 次往返（10 道题就是 10 次），所以 batch 模式保留为可选项。
     *
     * 严格串行，不并发：并发容易触发接口限流（429），而且进度会交错、
     * 用户反而看不清。慢一点但可读，更符合这个功能的初衷。
     *
     * 返回实际填成功的题数。**没答上的题不记入 handled**，
     * 由 loop() 统一走 retryLater，下一轮观察会自动重试。
     */
    async answerOneByOne(fresh) {
      let ok = 0;
      const total = fresh.length;

      for (let i = 0; i < total; i++) {
        const q = fresh[i];

        // 中途被用户关掉开关就停手，别把剩下的题都问完
        if (!CONFIG.answerEnabled) {
          log('答题开关已关闭，停止逐题作答');
          break;
        }

        // 这一道可能在等前一道的时候，被同源的另一层 frame 填过了
        if (this.elFilled(q)) {
          this.handled.add(q.sig);
          this.markOne(q, 'ok', '已作答（其他 frame 已填）');
          ok++;
          continue;
        }

        this.markOne(q, 'asking', `AI 作答中…（${i + 1}/${total}）`);

        let answers = {};
        try {
          answers = await this.askApi([q]);
        } catch (e) {
          warn(`第 ${q.index + 1} 题请求异常:`, e.message || e);
          answers = {};
        }

        const a = answers[q.id];
        if (a === undefined || a === null || a === '') {
          // 先标"未作答"，重试与否由 loop() 里的 retryLater 决定
          this.markOne(q, 'none', '未作答：无答案');
          continue;
        }

        if (this.applyOne(q, a)) {
          ok++;
          this.qTries.delete(q.sig);   // 成功了就把重试计数清掉
        }
      }

      return ok;
    },

    /** 题目容器。会自动钻进同源的嵌套 iframe（见 questionRoot 的说明） */
    findContainers() {
      const root = questionRoot();
      if (!root) return [];
      for (const sel of Q_SELECTORS.container) {
        try {
          const list = Array.from(root.querySelectorAll(sel));
          if (list.length) return list;
        } catch (e) { /* 忽略 */ }
      }
      return [];
    },

    /** 抓取题目：题干 + 选项 + 题型 */
    collect() {
      /*
       * 文本还原。
       *
       * 题目所在 frame 若被 font-cxsecret 混淆过，SecretFont 已经建好
       * 「码位 → 真字」的映射（见 checkFontObfuscation）；这里只管套上去。
       * 没有映射时 decode() 原样返回 —— 未混淆的页面走的就是这条路。
       */
      const doc = questionRoot() || document;
      const dec = (s) => SecretFont.decode(doc, s);

      // 跳过已经被填过的题（可能是本 frame 之前填的，也可能是同源的另一层 frame 填的）
      const containers = this.findContainers().filter((el) => {
        try { return !el.hasAttribute(FILLED_MARK); } catch (e) { return true; }
      });
      return containers.map((el, idx) => {
        const stem = dec(this.pickText(el, Q_SELECTORS.stem) || '');
        const optionEls = this.pickAll(el, Q_SELECTORS.option);

        // 解析每个选项行的「字母 + 正文」。字母优先从文本里抠，抠不到就按位置推。
        const parsed = optionEls.map((o, i) => {
          const raw = dec((o.textContent || '').replace(/\s+/g, ' ').trim());
          // 选项形如 "A、内容" / "A 内容" / "内容"
          const m = raw.match(/^([A-Za-z])[、.．\s]+(.*)$/);
          const key = m ? m[1].toUpperCase() : String.fromCharCode(65 + i);
          const text = m ? m[2].trim() : raw;
          return { key, text, el: o };
        });

        // 发给 API 的选项表：正文为空的（比如纯图片选项）没有意义，去掉
        const options = parsed.filter((o) => o.text);

        /*
         * key → 选项元素 的映射，从**未过滤**的 parsed 建。
         *
         * 为什么不能用下标取元素：上面那个过滤会丢掉空文本的选项，
         * 而 fillOne 原本是按 `字母.charCodeAt(0) - 65` 取下标的。
         * 只要有一个选项被过滤掉，后面所有字母的对应关系就整体错位 ——
         * 答案 "D" 会去取第 4 个元素，而过滤后的数组只剩 3 个，取到 undefined，
         * 于是报"找不到对应选项"。这类错位是静默的：看起来只是"某道题没填上"。
         *
         * 所以这里显式建映射，fillOne 优先查它，下标只作兜底。
         */
        const optionByKey = {};
        for (const o of parsed) if (!optionByKey[o.key]) optionByKey[o.key] = o.el;

        const blanks = this.pickAll(el, Q_SELECTORS.blank);

        // 题型推断
        let type = 'single';
        const typeHint = ((el.querySelector('.newZy_TItle, .TiMuTitle, .mark_type') || {}).textContent || stem || '');
        if (/多选/.test(typeHint)) type = 'multi';
        else if (/判断/.test(typeHint)) type = 'judge';
        else if (/填空/.test(typeHint) || blanks.length) type = 'blank';
        else if (/简答|论述|名词解释/.test(typeHint)) type = 'essay';
        else {
          const multi = el.querySelector('input[type="checkbox"]');
          const radio = el.querySelector('input[type="radio"]');
          if (multi) type = 'multi';
          else if (!radio && !options.length) type = 'blank';
        }

        const sig = `${idx}::${stem.slice(0, 80)}`;

        return {
          id: `q${idx + 1}`,
          index: idx,
          type,
          question: stem.replace(/\s+/g, ' ').trim(),
          options: options.map(({ key, text }) => ({ key, text })),
          sig,
          el,
          optionEls: options.map((o) => o.el),
          allOptionEls: optionEls,      // 未过滤：判断题等按位置取元素时用
          optionByKey,                  // 字母 → 元素，不受过滤影响
          blankEls: blanks,
        };
      }).filter((q) => q.question);
    },

    pickText(root, selectors) {
      for (const sel of selectors) {
        const n = root.querySelector(sel);
        if (n && (n.textContent || '').trim()) return n.textContent;
      }
      return '';
    },

    pickAll(root, selectors) {
      for (const sel of selectors) {
        const list = Array.from(root.querySelectorAll(sel));
        // 过滤掉嵌套重复：只保留最内层匹配
        const filtered = list.filter((n) => !list.some((o) => o !== n && n.contains(o)));
        if (filtered.length) return filtered;
      }
      return [];
    },

    /* ---------- 调外部 API ---------- */

    async askApi(questions) {
      if (CONFIG.apiMode === 'custom') return this.askCustom(questions);
      return this.askAI(questions);
    },

    /*
     * 模式 A：直连大模型（默认）。
     *
     * 用户只需要填地址 + 密钥 + 模型，剩下全部内置：
     *   - 端点自动补全（resolveChatEndpoint）
     *   - Authorization: Bearer <key>
     *   - messages = [system: 提示词, user: 题目 JSON]
     *   - 响应从 choices[0].message.content 取，解析走 resolveAnswers
     *
     * 之所以不做成"用户自己写请求体"，是因为大模型的调用格式基本是统一的
     * （OpenAI 兼容已成事实标准），把这层暴露出去只会让配置变复杂、错得更多。
     * 真正格式特殊的网关，走 custom 模式。
     */
    async askAI(questions) {
      const endpoint = resolveChatEndpoint(CONFIG.apiUrl, CONFIG.apiUrlFull);
      if (!endpoint) {
        warn('未填写 API 地址，跳过答题');
        return this.fallback(questions);
      }

      const payload = questions.map((q) => ({
        id: q.id,
        type: q.type,
        question: q.question,
        options: q.options,
      }));

      const system = String(CONFIG.promptTemplate || '').trim() || DEFAULT_PROMPT;
      const headers = { 'Content-Type': 'application/json' };
      if (CONFIG.apiKey) headers.Authorization = 'Bearer ' + String(CONFIG.apiKey).trim();

      const body = JSON.stringify({
        model: CONFIG.apiModel || 'gpt-4o-mini',
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: '题目如下（JSON 数组）：\n' + JSON.stringify(payload) },
        ],
        temperature: 0.2,   // 答题要的是稳定复现，不是创造力
        stream: false,
      });

      /*
       * 密钥为空时：照发，但**不重试**。
       *
       * 为什么不像 `apiUrl` 为空那样直接 return fallback() ——
       * 因为"密钥为空"未必是漏填，有两种合法情形会让它为空而请求照样成立：
       *   · 密钥写在地址的 query 里（有些网关就是 ?api_key=xxx）；
       *   · 本地模型（Ollama / LM Studio / vLLM）本来就不要密钥。
       * 硬拦会把这几种用法一起打死，那是在修一个 bug 的同时造一个更大的。
       *
       * 但"空密钥 + 地址不可达"这个组合，恰恰是**第一次配的人**最容易踩的：
       * 他会盯着「请求中」挂几分钟（3 次 × 60s 超时），然后得出"脚本卡死了"。
       * 而配置类问题重试多少次都是同样的结果，所以这里只试一次。
       */
      const noKey = !CONFIG.apiKey;
      if (noKey) {
        warn('AI 模式下密钥为空。若你的接口不需要密钥（本地模型，或密钥写在地址里）请忽略；' +
             '否则这次请求多半会被拒 —— 去面板填上，本次不重试。');
      }

      log(`请求答题 API（AI 模式）: ${endpoint} · ${CONFIG.apiModel || '默认模型'} · 密钥 ${noKey ? '**未填**' : `已填（${String(CONFIG.apiKey).length} 字符）`}`);
      let res;
      try {
        res = await this.callApi('ai', endpoint, {
          url: endpoint,
          method: 'POST',
          headers,
          data: body,
          timeout: CONFIG.apiTimeout,
        }, noKey ? 0 : undefined);   // 0 = 不重试（总尝试次数 1）
      } catch (e) {
        warn('答题 API 调用失败:', this.explainApiError(e, endpoint));
        return this.fallback(questions);
      }

      let json = null;
      try { json = JSON.parse(res.responseText); } catch (e) { /* 不是 JSON 就走纯文本解析 */ }
      const text = json ? pickModelText(json) : String(res.responseText || '');

      if (!text) {
        warn('没能从响应里取出模型输出，检查地址是否指向了 /chat/completions。原始响应:',
             String(res.responseText || '').slice(0, 300));
        return this.fallback(questions);
      }

      const out = resolveAnswers(text, questions);
      const filled = Object.values(out).filter(Boolean).length;
      if (CONFIG.debug) log('模型原始输出:', text.slice(0, 500));
      log(`模型返回 ${filled}/${questions.length} 题答案`);
      if (filled < questions.length) {
        warn(`${questions.length - filled} 题没解析出答案。模型输出片段: ${text.slice(0, 200)}`);
      }
      return out;
    },

    /*
     * 模式 B：自定义接口（高级）。
     * v1.3.0 的行为原样保留 —— 地址/方法/请求头/请求体模板/响应路径全部用户自己定，
     * 用于接自建题库或格式不兼容 OpenAI 的网关。
     */
    async askCustom(questions) {
      const payload = questions.map((q) => ({
        id: q.id,
        type: q.type,
        question: q.question,
        options: q.options,
      }));

      const headers = this.parseHeaders();
      // {{questions}} 替换成题目数组 JSON；若模板里没有占位符，就把整个数组作为 body
      const bodyTpl = CONFIG.apiBodyTemplate || '{{questions}}';
      const body = bodyTpl.includes('{{questions}}')
        ? bodyTpl.replace('{{questions}}', JSON.stringify(payload))
        : JSON.stringify(payload);

      log(`请求答题 API（自定义模式）: ${CONFIG.apiUrlCustom}`);
      let res;
      try {
        res = await this.callApi('custom', CONFIG.apiUrlCustom, {
          url: CONFIG.apiUrlCustom,
          method: CONFIG.apiMethod || 'POST',
          headers,
          data: body,
          timeout: CONFIG.apiTimeout,
        });
      } catch (e) {
        warn('答题 API 调用失败:', this.explainApiError(e, CONFIG.apiUrlCustom));
        return this.fallback(questions);
      }

      let json;
      try {
        json = JSON.parse(res.responseText);
      } catch (e) {
        warn('API 返回不是合法 JSON:', res.responseText?.slice(0, 200));
        return this.fallback(questions);
      }

      const list = deepGet(json, CONFIG.respPath);
      if (!Array.isArray(list)) {
        warn('按路径取不到结果数组，检查「响应路径」配置。实际响应:', json);
        return this.fallback(questions);
      }

      const map = {};
      for (const item of list) {
        const id = String(item[CONFIG.respIdKey] ?? item.id ?? '');
        const ans = item[CONFIG.respAnswerKey] ?? item.answer ?? item.result ?? '';
        if (id) map[id] = ans;
      }

      // 按顺序回填（有些 API 不返回 id，只按顺序给答案）
      const out = {};
      questions.forEach((q, i) => {
        let a = map[q.id];
        if (a === undefined) a = list[i] ? (list[i][CONFIG.respAnswerKey] ?? list[i].answer ?? '') : '';
        out[q.id] = a;
      });

      log('API 返回答案:', out);
      return out;
    },

    fallback(questions) {
      if (!CONFIG.fallbackAnswer) return {};
      const out = {};
      questions.forEach((q) => { out[q.id] = CONFIG.fallbackAnswer; });
      log(`使用兜底答案 "${CONFIG.fallbackAnswer}"`);
      return out;
    },

    parseHeaders() {
      const raw = (CONFIG.apiHeaders || '').trim();
      if (!raw) return { 'Content-Type': 'application/json' };
      try {
        return JSON.parse(raw);
      } catch (e) {
        warn('Headers 不是合法 JSON，已回退默认值');
        return { 'Content-Type': 'application/json' };
      }
    },

    /* ---------- 页面上的作答进度 ---------- */

    /**
     * 批量设置进度徽标。
     * 受 CONFIG.showProgress 控制 —— 徽标会往页面里插元素，
     * 有些用户不希望在页面上看到任何改动，得能关掉。
     */
    markProgress(questions, state, text) {
      if (!CONFIG.showProgress) return;
      for (const q of questions) {
        try { QProgress.set(q.el, state, text); } catch (e) { /* 单题失败不影响其它 */ }
      }
    },

    markOne(q, state, text) {
      if (!CONFIG.showProgress) return;
      try { QProgress.set(q.el, state, text); } catch (e) { /* 忽略 */ }
    },

    /** 这道题在页面上是否已被标记为"填过了" */
    elFilled(q) {
      try { return !!q.el.hasAttribute(FILLED_MARK); } catch (e) { return false; }
    },

    /*
     * 某道题没答上时调用：记一次尝试，超过上限就放弃。
     *
     * 逐题作答最大的好处就是**可以只重试失败的那一道**，所以失败的题不能记进
     * handled（否则下一轮就被当成"处理过"跳过了）。但也不能无限重试 ——
     * 模型答不出来的题重试一百次还是答不出来，只会白烧接口额度。
     * 所以这里用一个计数封顶。
     */
    retryLater(q, why) {
      const n = (this.qTries.get(q.sig) || 0) + 1;
      this.qTries.set(q.sig, n);
      const cap = Math.max(0, Number(CONFIG.answerRetries) || 0);

      if (n > cap) {
        this.handled.add(q.sig);          // 放弃，不再进 fresh
        this.markOne(q, 'fail', `已放弃：${why}`);
        warn(`第 ${q.index + 1} 题${why}，重试 ${cap} 次仍未成功，不再重试`);
      } else {
        this.markOne(q, 'none', `${why}（待重试 ${n}/${cap}）`);
      }
      if (this.qTries.size > 300) this.qTries.clear();
    },

    /** 徽标里的答案要短。多选/填空的长答案截断，避免徽标被撑成一行。 */
    shortAnswer(ans) {
      const s = String(ans == null ? '' : ans).replace(/\s+/g, ' ').trim();
      return s.length > 12 ? s.slice(0, 12) + '…' : s;
    },

    /* ---------- 回填答案 ---------- */

    /**
     * 回填答案，返回**实际填成功的题数**。
     *
     * 返回值很重要：0 题意味着这次一个答案都没落地（API 挂了 / 全部解析失败），
     * 这时候绝对不能自动提交 —— 那等于交白卷，比不答还糟。
     */
    fill(questions, answers, opts) {
      /*
       * keepFailedUnhandled：没答上的题**不**记入 handled，留给下一轮观察重试。
       * 逐题模式必须开，否则失败的题永远不会被重试；
       * 整卷模式也开 —— 效果是"下次只重发没答上的那几道"，比重发整卷划算。
       */
      const keepFailed = !!(opts && opts.keepFailedUnhandled);
      let ok = 0;

      for (const q of questions) {
        let settled = false;   // 这道题是否已有结论（答上了 / 被别的 frame 答了）

        /*
         * 点击前的**最后一次**复核。
         *
         * collect() 已经过滤过 FILLED_MARK，但那只保证"取题那一刻"没被填过。
         * 从 collect() 到 fill() 之间隔着一次 API 往返（可能几十秒），
         * 同源的另一层 frame 完全可能在这段时间里把题填了。
         * 多选题的选项是 checkbox —— 再点一次不是"重复劳动"，是**取消勾选**。
         * 所以这里必须再确认一次，代价只是一次 hasAttribute。
         */
        try {
          if (q.el.hasAttribute(FILLED_MARK)) {
            this.markOne(q, 'ok', '已作答（其他 frame 已填）');
            settled = true;
            ok++;
          }
        } catch (e) { /* 拿不到属性就照常处理 */ }

        if (!settled) {
          const ans = answers[q.id];
          if (ans === undefined || ans === null || ans === '') {
            // 模型没给这道题答案（漏题 / 解析不出）—— 必须显式标出来，
            // 否则用户会以为"没显示就是没问题"，最后交上去才发现空着
            this.markOne(q, 'none', '未作答：无答案');
          } else {
            try {
              if (this.fillOne(q, String(ans))) {
                ok++;
                settled = true;
                // 打上"已填"标记：同源的另一层 frame 看到它就会跳过，避免重复点击
                try { q.el.setAttribute(FILLED_MARK, '1'); } catch (e) { /* 忽略 */ }
                this.markOne(q, 'ok', '已作答：' + this.shortAnswer(ans));
              } else {
                /*
                 * 这条路径以前**完全不打日志** —— 用户只看到一个红徽标，
                 * 而"找不到对应选项"恰恰是最需要上下文的一类失败：
                 * 是没抓到选项？字母对不上？还是题型判错了？三者的修法完全不同。
                 * 现在把解析结果原样打出来，让用户（和我）能直接核对。
                 */
                warn(`第 ${q.index + 1} 题回填失败：答案 "${this.shortAnswer(ans)}" 在页面上找不到对应选项` +
                     `\n    ${describeQuestion(q)}`);
                this.markOne(q, 'fail', '回填失败：找不到对应选项');
              }
            } catch (e) {
              warn(`第 ${q.index + 1} 题回填异常: ${(e && e.message) || e}` +
                   `\n    ${describeQuestion(q)}`);
              this.markOne(q, 'fail', '回填异常');
            }
          }
        }

        if (settled || !keepFailed) this.handled.add(q.sig);
      }
      /*
       * handled 是"这个 frame 生命周期内处理过的题"。
       * 现在观察是长期的，用户可能在一个 frame 里连着做十几套测验，
       * 所以要给个上限，别让它无限长下去（只需要"去过重"，不需要完整历史）。
       */
      if (this.handled.size > 300) {
        this.handled.clear();
        log('已处理题目签名过多，清空一次');
      }
      log(`已回填 ${ok}/${questions.length} 题`);
      return ok;
    },

    /**
     * 把一道题的答案解析成「要操作的元素」，**不产生任何副作用**。
     *
     * 抽出来是为了让演练模式（dry run）和真实回填走**同一段解析逻辑** ——
     * 如果演练用另一套判断，它验证的就不是真实行为，那种演练没有意义。
     *
     * @returns {{kind:'blank'|'choice', targets:Element[], reason:string}}
     *          targets 为空时 reason 说明为什么（这是给用户看的，要能指向行动）
     */
    resolveTargets(q, ans) {
      const A = String(ans == null ? '' : ans).trim();

      /*
       * 全部走「缺字段就当空」而不是直读属性。
       *
       * 上一版是 `q.blankEls.length` / `q.options.length` 这样直读的，
       * 只要题目对象少一个字段就抛 TypeError，被 fill() 的 catch 统一兜成
       * 「回填异常」—— 一句对用户毫无信息量的话。而真正的信息是"哪个字段缺了"，
       * 所以宁可返回"找不到对应选项"这条**带上下文**的路径。
       */
      const blankEls = q.blankEls || [];
      const options = q.options || [];
      const allEls = q.allOptionEls || q.optionEls || [];
      const byKey = q.optionByKey || null;

      // 填空 / 简答：直接落到填空元素上
      if (q.type === 'blank' || q.type === 'essay') {
        return blankEls.length
          ? { kind: 'blank', targets: blankEls, reason: '' }
          : { kind: 'blank', targets: [], reason: '这道题判成了填空，但页面上没找到可输入的填空元素' };
      }

      const letters = (A.toUpperCase().match(/[A-Z]/g) || []);

      // 判断题兼容：答案可能是 对/错/正确/错误/T/F
      if (q.type === 'judge' || (!letters.length && options.length === 2)) {
        const truthy = /^(对|正确|是|T|TRUE|√|Y|1)$/i.test(A);
        const target = allEls[truthy ? 0 : 1];
        return target
          ? { kind: 'choice', targets: [target], reason: '' }
          : { kind: 'choice', targets: [], reason: '这道题判成了判断，但页面上的选项元素不足 2 个' };
      }

      if (!letters.length) {
        return { kind: 'choice', targets: [], reason: `答案里没有可用的选项字母（收到 "${A.slice(0, 20)}"）` };
      }

      /*
       * 取元素：**先按字母查映射，查不到再按位置兜底**。
       *
       * 顺序不能反。按下标取是 `字母 - 65`，前提是"解析出的选项和页面上的选项
       * 一一对应、一个不少"。而 collect() 会过滤掉正文为空的选项（纯图片选项之类），
       * 一旦有过滤，下标就整体错位 —— 答案 "D" 会去取第 4 个元素，
       * 而过滤后的数组只剩 3 个，取到 undefined，报"找不到对应选项"。
       * 按字母查映射没有这个前提，所以它是主路径。
       */
      const pick = (L) => (byKey && byKey[L]) || allEls[L.charCodeAt(0) - 65] || null;

      const chosen = q.type === 'multi' ? letters : [letters[0]];
      const targets = [];
      const missing = [];
      for (const L of chosen) {
        const t = pick(L);
        if (t) targets.push(t);
        else missing.push(L);
      }
      return {
        kind: 'choice',
        targets,
        reason: missing.length
          ? `字母 ${missing.join('/')} 在页面上没有对应的选项元素`
          : '',
      };
    },

    fillOne(q, ans) {
      const A = String(ans == null ? '' : ans).trim();
      const r = this.resolveTargets(q, A);
      if (!r.targets.length) return false;

      // 填空 / 简答：按分隔符拆成多空
      if (r.kind === 'blank') {
        const parts = A.split(/\s*[|｜;；]\s*/);
        r.targets.forEach((el, i) => {
          const val = parts[i] ?? parts[0] ?? A;
          if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
            setNativeValue(el, val);
          } else {
            el.textContent = val;
            el.dispatchEvent(new Event('input', { bubbles: true }));
          }
        });
        return true;
      }

      for (const el of r.targets) this.clickOption(el);
      return true;
    },

    /**
     * 把一道题的答案落到页面上；演练模式下**只报告，不落地**。
     *
     * 这是"在真实测验页上安全取现场"的那条通路：脚本的作答对象是用户的
     * 真实成绩，而章节测验往往只能提交一次 —— 不能为了排查选择器，
     * 就拿他的卷子做实验。
     */
    applyOne(q, ans) {
      if (!CONFIG.dryRun) {
        return this.fill([q], { [q.id]: ans }, { keepFailedUnhandled: true }) > 0;
      }

      // 演练也要去重，否则每一轮观察都会把同一批题重问一遍
      this.handled.add(q.sig);

      const r = this.resolveTargets(q, ans);
      const okMark = r.targets.length ? '✓' : '✗';
      log(`[演练] ${okMark} 答案 "${this.shortAnswer(ans)}" → ` +
          (r.targets.length ? `命中 ${r.targets.length} 个元素（未点击）` : `找不到对应元素：${r.reason}`));
      log(`       ${describeQuestion(q)}`);

      if (r.targets.length) this.markOne(q, 'none', `演练：将填 ${this.shortAnswer(ans)}`);
      else this.markOne(q, 'fail', `演练：${r.reason || '找不到对应元素'}`);

      return r.targets.length > 0;
    },

    /** 用完整的鼠标事件序列点击，兼容依赖 mousedown/mouseup 的组件 */
    clickOption(el) {
      // 走 fireMouse：它会自己处理"沙箱里 view 不被接受"的情况，见那个函数的说明
      ['mousedown', 'mouseup', 'click'].forEach((t) => fireMouse(el, t));
      // 有些版本的选中态挂在父级 label 上
      if (el.tagName !== 'LABEL' && !el.querySelector('input')) {
        const lb = el.closest && el.closest('label');
        if (lb) fireMouse(lb, 'click');
      }
    },

    /* ---------- 提交 ---------- */

    /*
     * 提交二次确认弹窗最多点几次。
     * 不是"点得越多越好"：万一某个按钮点了不关弹窗，无限点下去会把页面点爆，
     * 所以给一个总量上限，超了就停手并告警。
     */
    MAX_DIALOG_CLICKS: 6,

    /**
     * 提交并**等待确认**。
     *
     * v1.2.0 只是点一下提交就完事了，既不确认是否提交成功，也不通知顶层。
     * 结果作业虽然提交了，但没人告诉顶层"这里完成了"，顶层只能靠 domWatch 盲点下一节按钮 ——
     * 那才是"检测还没做完就跳转"的根源。
     *
     * 现在：点击提交 → 处理网页自己的二次确认弹窗 → 等成功提示 → 确认后才通知顶层。
     *
     * ⚠️ **网页的二次确认弹窗必须在 waitSubmitted 的循环里处理**，不能在这里
     * 「sleep 一下、点一次」了事 —— 原因见 waitSubmitted 的说明。
     * 这是 v1.4.11 修掉的症状：答完题之后，提交停在确认框上，用户还得自己再点一下。
     */
    async submit() {
      const btn = this.findSubmit();
      if (!btn) return warn('未找到提交按钮，请手动提交');
      if (CONFIG.submitConfirm && !confirm('超星助手：确认提交本次作业？')) return log('已取消提交');

      log('点击提交');
      /*
       * 先落一条"点过提交"的持久记录，**再**点。
       *
       * 顺序不能反：点完之后页面可能立刻跳走 / 重载，那一行就永远执行不到了，
       * 而"跳走 + 重载"恰恰是最容易让脚本重新答一遍的场景（新实例，
       * done 和 handled 全丢，题目还在 DOM 里）。
       */
      const latched = this.markSubmitTried();
      btn.click();

      // 等"提交成功"或任务点完成标记（期间会持续点掉网页的确认弹窗）
      const ok = await this.waitSubmitted(CONFIG.submitWaitMs);
      if (!ok) {
        warn(`等待提交成功确认超时（${CONFIG.submitWaitMs}ms），**不自动跳转下一节**。` +
             (this.findDialogConfirm()
               ? '页面上仍有一个未处理的确认弹窗 —— 请手动点掉它，再确认作业是否已提交'
               : '请手动确认作业是否已提交'));
        /*
         * 这里**不 markDone** —— 提交到底成没成功我们并不知道，谎报"已完成"
         * 会让诊断误导人。但也不能什么都不做：上面那条记录已经落下了，
         * 下一轮 doneReason() 会读到它并按"已点过提交、未确认"停下 ——
         * 于是不会再重新答一遍，也不会再点一次提交。
         */
        if (!latched) {
          warn('（本任务点没能识别出唯一标识，无法落"已提交"记录 —— ' +
               '如果脚本随后又答了一遍，请把「诊断」里的「本任务点标识」一行发出来）');
        }
        return;
      }

      log('已确认提交成功 ✓');
      /*
       * 提交成功 = 这个任务点结束了。
       * 必须在这里就置位：否则观察循环会继续跑，而超星提交后往往会把题目
       * 重新渲染一遍（题干/容器 class 变了 → 题目签名变了），
       * 于是脚本会把同一批题当成"新题"再答一次、甚至再交一次。
       */
      this.markDone('已提交成功');
      this.confirmSubmitLatch();   // 把记录升级成"已确认"，诊断里能区分
    },

    /**
     * 提交相关操作的候选文档。
     *
     * 弹窗可能挂在三个地方，少一个都会变成"弹窗明明在屏幕上，脚本却看不见"：
     *   1) 本 frame —— 题目就在本 frame 时最常见
     *   2) 同源嵌套的题目文档 —— 题目在更深一层 iframe 里时
     *   3) **同源的父窗口** —— 超星的弹层是 layui，iframe 里调 parent.layer 时弹窗挂到顶层
     * 跨域访问会抛异常，捕获后跳过（跨域是真没办法）。
     */
    submitDocs() {
      const docs = [document];
      const push = (d) => { try { if (d && docs.indexOf(d) < 0) docs.push(d); } catch (e) { /* 忽略 */ } };

      push(questionRoot());

      /*
       * 同源子 iframe。
       * 有些版本的确认框是独立 iframe，不向下找就会漏。
       * 限量 8 个 —— 超星页面的 iframe 动辄十几个，而弹窗只可能在最上面几个里。
       */
      try {
        const frames = Array.from(document.querySelectorAll('iframe')).slice(0, 8);
        for (const f of frames) {
          try { push(f.contentDocument); } catch (e) { /* 跨域 */ }
        }
      } catch (e) { /* 忽略 */ }

      // 同源父窗口（超星的 layui 弹层可能挂在顶层）
      try {
        let w = window;
        for (let i = 0; i < 3 && w && w.parent && w.parent !== w; i++) {
          w = w.parent;
          if (w.document) push(w.document);
        }
      } catch (e) { /* 跨域，到此为止 */ }
      return docs;
    },

    /**
     * 找弹层里的"确定"按钮。**纯查找，无副作用** —— 所以 bench 可以直接喂迷你 DOM 测。
     *
     * 两道，按可靠性排序：
     *   1) **选择器** —— layui 的确定按钮有固定 class（`.layui-layer-btn0`），最可靠
     *   2) **文案** —— 兜住改版和非 layui 的弹层，但**必须限定在弹层容器内部**。
     *      整页搜「提交」会命中**提交按钮本身**，脚本就会疯狂点提交、反复弹确认框 ——
     *      比不点还糟。这是文案兜底唯一不能省的前置条件。
     *
     * 两道都**排除取消类文案**：点到「取消」等于把整份卷子的提交撤销掉。
     */
    findDialogConfirm(docs) {
      for (const d of (docs || this.submitDocs())) {
        /*
         * 第一道：按选择器找。
         *
         * ⚠️ **必须遍历所有匹配项、取第一个可见的**，不能只取 `querySelector` 的第一个。
         * layui 关弹窗有时只 hide 不 remove，页面上常常残留着历史弹窗的隐藏节点；
         * 而 `querySelector` 永远返回文档顺序里的第一个 —— 那个很可能正是隐藏的。
         * 于是屏幕上明明摆着弹窗，脚本却"看不见"。
         * 这是 v1.4.11 漏掉的一类情况，也是"弹窗依旧显示"最可能的原因之一。
         */
        for (const sel of Q_SELECTORS.dialogConfirm) {
          let nodes = [];
          try { nodes = Array.from(d.querySelectorAll(sel)); } catch (e) { continue; }
          for (const n of nodes) {
            if (!isVisible(n)) continue;
            if (isDialogCancel(buttonText(n))) continue;
            return n;
          }
        }

        // 第二道：已知弹层容器内部按文案找（覆盖改版后的类名通配）
        const byLayer = this.findByLayerText(d);
        if (byLayer) return byLayer;
      }
      return null;
    },

    /** 在已知弹层容器内部按文案找确定按钮 */
    findByLayerText(d) {
      for (const layerSel of Q_SELECTORS.dialogLayer) {
        let layers = [];
        try { layers = Array.from(d.querySelectorAll(layerSel)); } catch (e) { continue; }
        for (const layer of layers) {
          if (!isVisible(layer)) continue;
          let btns = [];
          try { btns = Array.from(layer.querySelectorAll(DIALOG_BTN_ANY)); } catch (e) { continue; }
          for (const b of btns) {
            if (isVisible(b) && isDialogConfirm(buttonText(b))) return b;
          }
        }
      }
      return null;
    },

    /**
     * 最后一道兜底：整页找"确定"类按钮，但要求它**长在看起来像弹层的容器里**。
     *
     * 比前两道贵（要遍历整页的按钮），所以由调用方限频 ——
     * 正常情况下前两道就命中了，轮不到它。
     *
     * 三个排除项一个都不能少：不能是提交按钮本身、不能在题目容器里、
     * 必须处在弹层类容器里。否则就可能点到页面上随便一个"确定"。
     */
    findAnyConfirmButton(docs) {
      const submitBtn = this.findSubmit();
      for (const d of (docs || this.submitDocs())) {
        let all = [];
        try { all = Array.from(d.querySelectorAll(DIALOG_BTN_ANY)); } catch (e) { continue; }
        for (const b of all) {
          if (!isVisible(b)) continue;
          if (!isDialogConfirm(buttonText(b))) continue;
          if (submitBtn && (b === submitBtn || (submitBtn.contains && submitBtn.contains(b)))) continue;
          if (b.closest && b.closest(QUESTION_ANY)) continue;
          if (!inPopupLike(b)) continue;
          return b;
        }
      }
      return null;
    },

    /** 页面上是否已经出现"提交成功"的迹象（waitSubmitted 的单次检查） */
    submittedNow(docs) {
      if (Completeness.markFound()) return true;
      // 超星的提交成功提示框
      const box = this.findInAnyDoc('.layui-layer-content, .jw_btn_confirm, #popok, .popup_content', docs);
      return !!(box && /提交成功|已提交|已完成|交卷成功/.test(box.textContent || ''));
    },

    /**
     * 在当前文档 / 同源嵌套文档 / 同源父窗口里找元素（弹窗可能被挂在任一侧）。
     *
     * `docs` 可选：轮询里复用同一份文档列表，避免每 500ms 重新扫一遍所有 iframe
     * （`submitDocs()` 会调 `questionRoot()`，那是要遍历 iframe 的）。
     * Document 引用本身是稳定的，DOM 查询仍然是实时的，所以复用不影响正确性。
     */
    findInAnyDoc(selector, docs) {
      for (const d of (docs || this.submitDocs())) {
        try {
          const n = d.querySelector(selector);
          if (n) return n;
        } catch (e) { /* 忽略 */ }
      }
      return null;
    },

    /**
     * 等"提交成功"，**期间持续点掉网页自己的二次确认弹窗**。
     *
     * 为什么这两件事必须在同一个循环里，而不是"先等 1.2 秒点一次确认、再等成功"：
     *
     *   1) **弹窗出现时机不确定。** 它取决于超星自己的渲染和接口往返，可能 200ms、
     *      也可能 2 秒。原来的写法是固定 `sleep(1200)` 之后只试一次 ——
     *      晚于 1200ms 出现的弹窗**永远点不到**，提交就停在确认框上，
     *      而 waitSubmitted 会一直等到超时。用户看到的就是
     *      「AI 答完题了，网页弹窗还要自己确认提交」。
     *   2) **可能有不止一个弹窗。** 常见组合是「确认提交」→ 提交后再弹「提交成功」，
     *      固定点一次只能处理第一个。
     *
     * 同一按钮最多点 2 次（防"点了没反应"变成连点），总量封顶 MAX_DIALOG_CLICKS。
     */
    /*
     * 判定成功之后再给弹窗留的收尾时间。
     *
     * 为什么需要：`submittedNow()` 可能**早于弹窗**成立 —— 页面上先冒出"已提交"
     * 字样，确认框才姗姗来迟。原来的实现一见成功就 break，那个刚弹出来的框就没人点，
     * 用户看到的还是"弹窗还得自己确认"。所以成功之后不立刻返回，再盯一小段。
     */
    DIALOG_TAIL_MS: 3000,

    /** 整页兜底扫描的最小间隔（它比前两道贵得多，不能每轮都做） */
    DEEP_SCAN_MS: 2000,

    async waitSubmitted(timeout) {
      const t0 = Date.now();
      const docs = this.submitDocs();   // 算一次就够：Document 引用稳定，查询是实时的
      const clicked = new WeakMap();    // 按钮 → 已点次数（WeakMap 不会拖住被移除的弹窗）
      let total = 0;
      let warned = false;
      let ok = false;
      let deepAt = 0;

      /** 找一次弹窗：先走便宜的两道，没命中再按 DEEP_SCAN_MS 限频做整页兜底 */
      const findDlg = () => {
        const fast = this.findDialogConfirm(docs);
        if (fast) return fast;
        if (Date.now() - deepAt < this.DEEP_SCAN_MS) return null;
        deepAt = Date.now();
        return this.findAnyConfirmButton(docs);
      };

      /** 找到就点，点到返回 true */
      const clickDialog = () => {
        const dlg = findDlg();
        if (!dlg) return false;
        const n = clicked.get(dlg) || 0;
        if (n >= 2 || total >= this.MAX_DIALOG_CLICKS) {
          if (total >= this.MAX_DIALOG_CLICKS && !warned) {
            warned = true;
            warn(`确认弹窗已点击 ${total} 次仍未关闭，停止点击。请手动处理页面上的弹窗`);
          }
          return false;
        }
        clicked.set(dlg, n + 1);
        total++;
        log(`点击网页的提交确认弹窗（第 ${total} 次）`);
        ['mousedown', 'mouseup', 'click'].forEach((t) => fireMouse(dlg, t));
        return true;
      };

      while (Date.now() - t0 < timeout) {
        if (this.submittedNow(docs)) { ok = true; break; }
        clickDialog();
        await sleep(500);
      }

      /*
       * 收尾窗口：不管成功与否，再盯弹窗一小段。
       *   · 成功早于弹窗出现 → 在这里补点
       *   · 超时（可能是"还有题没答完"的提醒框）→ 也把能点的点掉
       * 连续 3 轮都没看到弹窗就收工，避免让"本来就没弹窗"的页面白等。
       */
      const tailEnd = Date.now() + this.DIALOG_TAIL_MS;
      let misses = 0;
      while (Date.now() < tailEnd && misses < 3) {
        misses = clickDialog() ? 0 : misses + 1;
        await sleep(500);
      }

      return ok;
    },

    findSubmit() {
      const root = questionRoot() || document;
      for (const sel of Q_SELECTORS.submit) {
        try {
          const n = root.querySelector(sel);
          if (n) return n;
        } catch (e) { /* 忽略 */ }
      }
      const nodes = root.querySelectorAll('a, button, div[class*="btn"]');
      for (const n of nodes) {
        const t = (n.textContent || '').trim();
        if (/^(提交|交卷|确认提交)$/.test(t)) return n;
      }
      return null;
    },
  };

  /*
   * 鼠标事件的派发方式（全局探测一次）。
   *
   * **绝对不要写 `new MouseEvent(t, { view: window })`。**
   *
   * 油猴脚本带 @grant 时运行在沙箱里，沙箱的 `window` 不是页面的 Window 对象。
   * Firefox 会对 UIEventInit.view 做接口品牌检查，于是构造时直接抛：
   *
   *   MouseEvent constructor: 'view' member of UIEventInit
   *   does not implement interface Window.
   *
   * 后果不是"少点一下"——**每一次点击选项都会失败**，然后被上层兜成
   * 「回填异常」这种对用户毫无信息量的话。而且 Chrome 对这一点是宽松的，
   * 所以这个坑在 Chrome 上测不出来，只在 Firefox 上炸。
   *
   * 处理：优先用**元素自己所属文档**的 window（那才是页面真正的 Window），
   * 构造失败就干脆不带 view —— view 是可选字段，绝大多数点击处理器不读它。
   * 探测结果缓存起来，不给每次点击都加一次 try/catch 的开销。
   */
  let mouseViewOk = null;   // null = 未探测 | true = 可以带 view | false = 不带 view

  function fireMouse(el, type) {
    const base = { bubbles: true, cancelable: true };
    const docWin = (el.ownerDocument && el.ownerDocument.defaultView) || null;

    if (mouseViewOk === null) {
      const candidate = docWin || (typeof window !== 'undefined' ? window : null);
      mouseViewOk = false;
      if (candidate) {
        try {
          new MouseEvent(type, { ...base, view: candidate });
          mouseViewOk = true;
        } catch (e) {
          // 沙箱里的 window 过不了 Firefox 的接口检查 —— 退回不带 view
          log('MouseEvent 不接受 view（油猴沙箱环境），改为不带 view 派发');
        }
      }
    }

    // 每次都取当前元素所属文档的 window：同源嵌套 iframe 里文档可能不同
    const opts = (mouseViewOk && docWin) ? { ...base, view: docWin } : base;
    try {
      return el.dispatchEvent(new MouseEvent(type, opts));
    } catch (e) {
      // 连 MouseEvent 都构造不出来（极老的浏览器）→ 退回通用 Event，
      // 宁可丢掉鼠标语义，也好过整条回填链路抛异常
      return el.dispatchEvent(new Event(type, base));
    }
  }

  /** React/Vue 受控输入必须走原生 setter，否则框架不认 */
  function setNativeValue(el, value) {
    const proto = el.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  /* ============================================================
   * 6. 文档 / PPT 阅读模块
   * ============================================================ */

  /*
   * 超星的「阅读」任务点**不是翻页文档**，别拿它当 PDF 处理。
   *
   * 真机实测（2026-09-22，`12.1 阅读`，chapterId=1250629013）：
   * 打开后是一张**书单**，页面原文写着
   *     「您的阅读总时长: 0.0 分钟（当天阅读时长，次日更新），
   *       点击去阅读，可完成阅读任务点」
   * 完成条件是**真人的阅读时长**，书要跳到外部阅读器里去读。
   *
   * 页面上没有"下一页"可点 —— 实测三层 frame（顶层 / ananas/modules/read /
   * coursedata/readjobv2）里，DocModule 那套
   * `.next / .pageNext / #next / .nextPage / [class*=next-page] / .swiper-button-next`
   * 的可命中数全是 0，其中 read 和 readjobv2 两层甚至一个 `<a>`/`<button>` 都没有
   * （body 只有 1.7KB / 2.4KB 的空壳）。
   *
   * 所以对这类任务点，DocModule 的自动化**没有对象**：硬跑只会在空壳 frame 里
   * 空转，运气不好还会点到页面上别的 `.next` 元素。这里明确认出来并说清楚 ——
   * 让用户知道"这个得自己去读"，而不是以为脚本坏了。
   */
  const READ_TASK_RE = /\/ananas\/modules\/read\/|\/coursedata\/readjobv2\//i;

  function isReadingTimeTask() {
    try {
      if (READ_TASK_RE.test(location.pathname)) return true;
    } catch (e) { /* 忽略 */ }
    // 兜底：路径变了也能靠页面特征认出来（书单页的特征元素）
    try {
      if (document.querySelector('.readScanList, .readTips, .readContent .readInfo')) return true;
    } catch (e) { /* 忽略 */ }
    return false;
  }

  const DocModule = {
    timer: null,
    stopped: false,
    done: false,

    start() {
      if (!CONFIG.docEnabled) return;

      /*
       * 「阅读时长」型任务点：先认出来，再说清楚，然后**不要启动**循环。
       * 启动一个只会空转（甚至可能误点）的模块，比什么都不做更糟。
       */
      if (isReadingTimeTask()) {
        this.stopped = true;
        if (this.timer) { Timers.clear(this.timer); this.timer = null; }
        log('这是「阅读时长」型任务点：完成条件是真人阅读时长（次日更新），脚本无法代劳，已跳过。');
        log('  想完成它得点页面上的「去阅读」自己读。脚本在这里不做任何事 —— 也不会假装做了。');
        return;
      }

      log('文档阅读模块启动');
      this.done = false;
      this.stopped = false;
      this.tick();
      // 用 setTimeout 递归而不是 setInterval：文档加载慢时不会堆积回调
      const loop = () => {
        if (this.stopped) return;
        this.timer = Timers.after(() => { this.tick(); loop(); }, Math.max(2000, CONFIG.docPageDelay));
      };
      loop();
    },

    stop() {
      this.stopped = true;
      if (this.timer) Timers.clear(this.timer);
    },

    tick() {
      // 翻到最后一页且页面出现完成标记时，才算这个任务点结束
      if (CONFIG.requireComplete && Completeness.markFound()) {
        if (!this.done) {
          this.done = true;
          log('文档任务点已完成 ✓');
        }
        return;
      }

      // 常见的"下一页"控件
      const nexts = document.querySelectorAll(
        '.next, .pageNext, #next, .nextPage, [class*="next-page"], .swiper-button-next'
      );
      for (const n of nexts) {
        const disabled = n.classList.contains('disabled') || n.getAttribute('aria-disabled') === 'true';
        // 先看 class 再看可见性：isVisible 优先走 checkVisibility，不触发强制同步布局
        if (!disabled && isVisible(n)) {
          if (!breaker.allow('文档翻页', 30, 60000)) return;
          log('文档翻页');
          this.clickOptionLike(n);
          return;
        }
      }
      // 滚动型文档
      const doc = document.scrollingElement || document.documentElement;
      if (doc.scrollHeight > window.innerHeight * 1.5) {
        const atBottom = doc.scrollTop + window.innerHeight >= doc.scrollHeight - 50;
        if (!atBottom) window.scrollBy({ top: window.innerHeight * 0.8, behavior: 'smooth' });
      }
    },

    /** 点"下一页"之类的按钮。同样走 fireMouse —— 原因见那个函数。 */
    clickOptionLike(el) {
      ['mousedown', 'mouseup', 'click'].forEach((t) => fireMouse(el, t));
    },
  };

  /* ============================================================
   * 7. 顶层：控制面板 + 自动下一节
   * ============================================================ */

  const Panel = {
    root: null,
    body: null,

    mount() {
      if (document.getElementById('cx-auto-panel')) return;

      const host = document.createElement('div');
      host.id = 'cx-auto-panel';
      host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;';
      const shadow = host.attachShadow({ mode: 'open' });

      shadow.innerHTML = `
        <style>
          :host { all: initial; }
          * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
          .wrap {
            position: fixed; right: 16px; bottom: 16px; width: 330px;
            background: #1b1d23; color: #e6e8ee; border: 1px solid #2e323c;
            border-radius: 12px; box-shadow: 0 10px 34px rgba(0,0,0,.45);
            font-size: 12px; overflow: hidden;
            contain: layout style;   /* 隔离面板内部布局，避免影响页面主文档 */
          }
          .hd {
            display: flex; align-items: center; justify-content: space-between;
            padding: 9px 12px; background: #22252d; cursor: move; user-select: none;
            font-weight: 600; font-size: 13px; color: #fff;
          }
          .hd .dot { width: 8px; height: 8px; border-radius: 50%; background: #3ddc84; margin-right: 7px; display:inline-block; }
          .hd .dot.off { background: #6b7280; }
          .hd button { background: transparent; border: 0; color: #9aa2b1; cursor: pointer; font-size: 15px; line-height: 1; padding: 0 2px; }
          .hd button:hover { color: #fff; }
          /* 版本号必须显示出来 —— "改了没生效"最常见的真相就是浏览器里还是旧版 */
          .hd .ver { color: #6f7889; font-size: 10px; font-weight: 400; margin-left: 3px; }
          .bd { padding: 10px 12px; max-height: 62vh; overflow-y: auto; }
          .wrap.collapsed .bd { display: none; }
          .sec { border-top: 1px solid #2b2f38; padding: 9px 0 4px; }
          .sec:first-child { border-top: 0; padding-top: 2px; }
          .sec h4 { margin: 0 0 8px; font-size: 11px; letter-spacing: .08em; color: #7d8798; text-transform: uppercase; font-weight: 600; }
          .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 7px; }
          .row > span { color: #b9c0cd; flex: 0 0 auto; }
          input[type=text], input[type=password], input[type=number], select, textarea {
            background: #14161b; border: 1px solid #333846; color: #e6e8ee;
            border-radius: 6px; padding: 5px 7px; font-size: 12px; width: 100%; outline: none;
          }
          input[type=text]:focus, input[type=password]:focus, textarea:focus, select:focus { border-color: #4c8bf5; }
          textarea { resize: vertical; min-height: 62px; font-family: ui-monospace, Consolas, monospace; line-height: 1.5; }
          .row input[type=text], .row input[type=password], .row select, .row input[type=number] { flex: 1 1 auto; min-width: 0; }
          input[type=checkbox] { accent-color: #4c8bf5; width: 15px; height: 15px; cursor: pointer; }
          .btns { display: flex; gap: 7px; margin-top: 8px; }
          .btns button {
            flex: 1; padding: 7px 0; border-radius: 7px; border: 1px solid #3a4050;
            background: #262a33; color: #dfe3ea; cursor: pointer; font-size: 12px;
          }
          .btns button:hover { background: #303541; }
          .btns button.primary { background: #2f6fe0; border-color: #2f6fe0; color: #fff; }
          .btns button.primary:hover { background: #3d7cf0; }
          .btns button.danger { background: #7a2b2b; border-color: #8f3535; color: #ffdede; }
          .btns button.danger:hover { background: #8f3535; }
          .log {
            background: #0f1115; border: 1px solid #262a33; border-radius: 6px;
            padding: 7px; height: 120px; overflow-y: auto; font-family: ui-monospace, Consolas, monospace;
            font-size: 10.5px; line-height: 1.55; color: #9fb4d0; white-space: pre-wrap; word-break: break-all;
            contain: content;
          }
          .tip { color: #6f7889; font-size: 10.5px; line-height: 1.5; margin: 4px 0 0; }
          .badge { font-size: 10px; padding: 1px 6px; border-radius: 99px; background: #2b3140; color: #9aa2b1; }
          .lnk { color: #6ea8ff; cursor: pointer; font-size: 10.5px; text-decoration: none; }
          .lnk:hover { text-decoration: underline; }
          textarea.tall { min-height: 150px; }
          .sub { border-left: 2px solid #2f3542; padding-left: 8px; margin: 4px 0 8px; }
          .sub > .lbl { display: block; color: #6f7889; font-size: 10px; letter-spacing: .06em; margin-bottom: 6px; }
        </style>
        <div class="wrap" id="wrap">
          <div class="hd" id="hd">
            <span><i class="dot" id="dot"></i>超星助手 <span class="ver">v${SCRIPT_VERSION}</span></span>
            <span>
              <button id="btnMin" title="折叠">—</button>
            </span>
          </div>
          <div class="bd" id="bd"></div>
        </div>
      `;

      document.documentElement.appendChild(host);
      this.root = shadow.getElementById('wrap');
      this.body = shadow.getElementById('bd');
      this.shadow = shadow;

      this.render();
      this.makeDraggable(shadow.getElementById('hd'));
      shadow.getElementById('btnMin').onclick = () => {
        const collapsed = this.root.classList.toggle('collapsed');
        saveConfig({ panelCollapsed: collapsed });
      };
      if (CONFIG.panelCollapsed) this.root.classList.add('collapsed');

      this.startLogPoll(shadow);
    },

    /*
     * 日志轮询。
     * v1.0.0 是 1 秒一次无条件重建：GM_getValue（同步）+ textContent 重写 + 读 scrollHeight
     * （强制重排）。现在改成：折叠时不刷、内容没变不刷、2 秒一次，并且用户手动往上滚时
     * 不再强行拉到底（读 scrollHeight 本身就是一次强制布局，能省则省）。
     *
     * ⚠️「内容没变」的判据必须用 logSignature()，**不能**用 buf.length。
     * 缓冲被截在 120 条，写满后长度恒定，用长度判断会让日志区永久冻住 ——
     * v1.5.2 的真机故障就是这么来的，详见 logSignature 的注释。
     */
    startLogPoll(shadow) {
      // 幂等：重复调用（比如紧急停止后重启）不会叠出多个轮询
      if (this.pollTimer) Timers.clear(this.pollTimer);
      let lastSig = '';
      this.pollTimer = Timers.every(() => {
        if (!this.root || this.root.classList.contains('collapsed')) return;
        const buf = GM_getValue(LOG_KEY, []);
        const sig = logSignature(buf);
        if (sig === lastSig) return;
        lastSig = sig;

        const box = shadow.getElementById('logBox');
        if (!box) return;
        const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
        box.textContent = buf.slice(-60).join('\n');
        if (atBottom) box.scrollTop = box.scrollHeight;
      }, 2000);
    },

    render() {
      const c = CONFIG;
      this.body.innerHTML = `
        <div class="sec">
          <h4>视频</h4>
          <div class="row"><span>自动播放</span><input type="checkbox" id="videoEnabled" ${c.videoEnabled ? 'checked' : ''}></div>
          <div class="row"><span>静音</span><input type="checkbox" id="videoMute" ${c.videoMute ? 'checked' : ''}></div>
          <div class="row"><span>防暂停</span><input type="checkbox" id="keepPlaying" ${c.keepPlaying ? 'checked' : ''}></div>
          <div class="row"><span>自动下一节</span><input type="checkbox" id="autoNext" ${c.autoNext ? 'checked' : ''}></div>
          <div class="row"><span>倍速</span>
            <select id="videoSpeed">
              ${[1, 1.25, 1.5, 1.75, 2].map((s) => `<option value="${s}" ${Number(c.videoSpeed) === s ? 'selected' : ''}>${s}x</option>`).join('')}
            </select>
          </div>
          <div class="row"><span>有进度跳结尾</span><input type="checkbox" id="videoJumpToEnd" ${c.videoJumpToEnd ? 'checked' : ''}></div>
          <div class="row"><span>最小进度(秒)</span><input type="number" id="videoJumpMinProgress" value="${Number(c.videoJumpMinProgress) || 0}" min="0" step="1"></div>
          <div class="row"><span>侵入式反暂停</span><input type="checkbox" id="aggressiveAntiPause" ${c.aggressiveAntiPause ? 'checked' : ''}></div>
          <p class="tip">「有进度跳结尾」：播放器已经带着上次的进度打开时，直接跳到末尾试一次，跳完仍走完整的完成确认。超星按累计播放时长算进度，<b>seek 不一定被接受</b>；不被接受会自动退回原位置继续播。「最小进度」是判定门槛，低于它当作从头播，不跳。</p>
          <p class="tip">「侵入式反暂停」会篡改页面的 document.hidden，可能干扰超星自身的资源清理逻辑。<b>默认关闭</b>，只有防暂停压不住切屏暂停时才打开。</p>
        </div>

        <div class="sec">
          <h4>任务完成判定 <span class="badge">本地确认</span></h4>
          <div class="row"><span>跳转前确认完成</span><input type="checkbox" id="requireComplete" ${c.requireComplete ? 'checked' : ''}></div>
          <div class="row"><span>播完后等待(ms)</span><input type="number" id="reportSettleMs" value="${c.reportSettleMs}" min="0" step="1000"></div>
          <div class="row"><span>等标记超时(ms)</span><input type="number" id="completeWaitMs" value="${c.completeWaitMs}" min="3000" step="1000"></div>
          <div class="row" style="display:block">
            <span style="display:block;margin-bottom:4px">完成标记选择器（逗号分隔）</span>
            <textarea id="completeSelectors">${esc(c.completeSelectors)}</textarea>
          </div>
          <p class="tip"><b>自动下一节</b>的唯一依据是<b>目录里当前章节的完成标记</b>：显示「已完成」就点下一节，没显示就一直等。上面这个选择器对不上，脚本就永远不跳 —— 点「诊断」能看到每个选择器命中了几个元素。<br>「跳转前确认完成」只作用于视频 / 文档自己的本地确认流程，<b>不再决定要不要跳转</b>。</p>
        </div>

        <div class="sec">
          <h4>文档 / PPT</h4>
          <div class="row"><span>自动翻页</span><input type="checkbox" id="docEnabled" ${c.docEnabled ? 'checked' : ''}></div>
        </div>

        <div class="sec">
          <h4>答题 <span class="badge" id="modeBadge">${c.apiMode === 'custom' ? '自定义接口' : 'AI 直连'}</span></h4>
          <div class="row"><span>启用</span><input type="checkbox" id="answerEnabled" ${c.answerEnabled ? 'checked' : ''}></div>
          <div class="row"><span>题旁显示进度</span><input type="checkbox" id="showProgress" ${c.showProgress ? 'checked' : ''}></div>
          <div class="row"><span>作答方式</span>
            <select id="answerMode">
              <option value="per" ${c.answerMode !== 'batch' ? 'selected' : ''}>逐题作答（推荐）</option>
              <option value="batch" ${c.answerMode === 'batch' ? 'selected' : ''}>整卷一次</option>
            </select>
          </div>
          <div class="row"><span>失败重试次数</span><input type="number" id="answerRetries" min="0" max="5" value="${Number(c.answerRetries) || 0}"></div>
          <div class="row"><span>演练模式</span><input type="checkbox" id="dryRun" ${c.dryRun ? 'checked' : ''}></div>
          <p class="tip">演练：只抓题、调接口、报告"打算填什么"，<b>不点选项、不提交</b>。排查选择器问题时先开它。</p>
          <div class="row"><span>接口模式</span>
            <select id="apiMode">
              <option value="ai" ${c.apiMode !== 'custom' ? 'selected' : ''}>AI 直连（内置提示词）</option>
              <option value="custom" ${c.apiMode === 'custom' ? 'selected' : ''}>自定义接口（高级）</option>
            </select>
          </div>

          <div id="aiFields">
            <div class="row"><span>API 地址</span><input type="text" id="apiUrl" value="${esc(c.apiUrl)}" placeholder="https://api.openai.com/v1"></div>
            <div class="row"><span>API 密钥</span><input type="password" id="apiKey" value="${esc(c.apiKey)}" placeholder="sk-..."></div>
            <div class="row"><span>模型</span><input type="text" id="apiModel" value="${esc(c.apiModel)}" placeholder="gpt-4o-mini"></div>
            <div class="row" style="display:block">
              <span style="display:block;margin-bottom:4px">系统提示词 <a class="lnk" id="btnResetPrompt">恢复默认</a></span>
              <textarea id="promptTemplate" class="tall">${esc(c.promptTemplate)}</textarea>
            </div>
            <div class="row"><span>地址已是完整路径</span><input type="checkbox" id="apiUrlFull" ${c.apiUrlFull ? 'checked' : ''}></div>
            <p class="tip">
              地址填 <b>base</b> 即可（如 <code>https://api.openai.com/v1</code>），脚本自动补 <code>/chat/completions</code>；
              兼容 OpenAI / DeepSeek / 通义 / 各类中转站。只有路径不规则的网关才需要勾「完整路径」。
              提示词里必须保留 <code>id</code> 与 <code>answer</code> 的输出约定，否则回填会失败。
            </p>
          </div>

          <div id="customFields" class="sub">
            <span class="lbl">自定义接口（仅自定义模式生效）</span>
            <div class="row"><span>地址</span><input type="text" id="apiUrlCustom" value="${esc(c.apiUrlCustom)}" placeholder="https://..."></div>
            <div class="row"><span>方法</span>
              <select id="apiMethod">
                <option ${c.apiMethod === 'POST' ? 'selected' : ''}>POST</option>
                <option ${c.apiMethod === 'GET' ? 'selected' : ''}>GET</option>
              </select>
            </div>
            <div class="row" style="display:block">
              <span style="display:block;margin-bottom:4px">请求头 (JSON)</span>
              <textarea id="apiHeaders">${esc(c.apiHeaders)}</textarea>
            </div>
            <div class="row" style="display:block">
              <span style="display:block;margin-bottom:4px">请求体模板（<code>{{questions}}</code> 为占位符）</span>
              <textarea id="apiBodyTemplate">${esc(c.apiBodyTemplate)}</textarea>
            </div>
            <div class="row"><span>响应路径</span><input type="text" id="respPath" value="${esc(c.respPath)}" placeholder="data"></div>
            <div class="row"><span>id 字段</span><input type="text" id="respIdKey" value="${esc(c.respIdKey)}"></div>
            <div class="row"><span>答案字段</span><input type="text" id="respAnswerKey" value="${esc(c.respAnswerKey)}"></div>
            <p class="tip">响应约定：<code>{"${esc(c.respPath || '')}":[{"id":"q1","answer":"A"}]}</code>；多选写 "AB"，判断写 "对"/"错" 或 "A"/"B"，填空多空用 | 分隔。</p>
          </div>

          <div class="row"><span>自动提交</span><input type="checkbox" id="autoSubmit" ${c.autoSubmit ? 'checked' : ''}></div>
          <div class="row"><span>提交前确认</span><input type="checkbox" id="submitConfirm" ${c.submitConfirm ? 'checked' : ''}></div>
          <div class="row"><span>兜底答案</span><input type="text" id="fallbackAnswer" value="${esc(c.fallbackAnswer)}" placeholder="留空=跳过"></div>
          <p class="tip">
            AI 模式下<strong>密钥只存在本地</strong>，只用于给上面那个地址发 <code>Authorization</code> 头。
            模型不按格式返回时脚本会逐层降级解析；仍然解析不出的题会跳过（除非填了兜底答案）。
          </p>
        </div>

        <div class="sec">
          <h4>性能</h4>
          <div class="row"><span>收集运行日志</span><input type="checkbox" id="logEnabled" ${c.logEnabled ? 'checked' : ''}></div>
          <div class="row"><span>控制台调试输出</span><input type="checkbox" id="debug" ${c.debug ? 'checked' : ''}></div>
          <p class="tip">觉得卡就关掉日志；只在排查问题时开调试输出。</p>
        </div>

        <div class="sec">
          <div class="btns">
            <button id="btnTest">测试 API</button>
            <button id="btnDiag">诊断</button>
            <button id="btnStruct">结构诊断</button>
            <button class="primary" id="btnSave">保存</button>
          </div>
          <div class="btns">
            <button id="btnRefresh">重新执行</button>
            <button id="btnPopup">弹窗诊断</button>
            <button id="btnExportLog">导出日志</button>
            <button id="btnClearLog">清空日志</button>
          </div>
          <div class="btns">
            <button class="danger" id="btnKill">紧急停止</button>
          </div>
          <p class="tip">日志只存在 Tampermonkey 本地存储里（脚本 → Storage 标签可查），不会上传。导出的文件会自动打码 API 密钥。</p>
        </div>

        <div class="sec">
          <h4>运行日志</h4>
          <div class="log" id="logBox"></div>
        </div>
      `;

      const $ = (id) => this.body.querySelector('#' + id);

      const bindToggle = (id, key) => {
        $(id).addEventListener('change', (e) => {
          saveConfig({ [key]: e.target.checked });
          log(`设置 ${key} = ${e.target.checked}`);
        });
      };
      bindToggle('videoEnabled', 'videoEnabled');
      bindToggle('videoMute', 'videoMute');
      bindToggle('keepPlaying', 'keepPlaying');
      bindToggle('videoJumpToEnd', 'videoJumpToEnd');
      bindToggle('autoNext', 'autoNext');
      bindToggle('aggressiveAntiPause', 'aggressiveAntiPause');
      bindToggle('requireComplete', 'requireComplete');
      bindToggle('docEnabled', 'docEnabled');
      bindToggle('answerEnabled', 'answerEnabled');
      bindToggle('showProgress', 'showProgress');
      bindToggle('dryRun', 'dryRun');
      bindToggle('autoSubmit', 'autoSubmit');
      bindToggle('submitConfirm', 'submitConfirm');
      bindToggle('logEnabled', 'logEnabled');
      bindToggle('debug', 'debug');

      $('videoSpeed').addEventListener('change', (e) => saveConfig({ videoSpeed: Number(e.target.value) }));

      // 最小进度门槛：夹在 0~600，手输 99999 会让"有进度"永远不成立（等于静默关掉这个功能）
      $('videoJumpMinProgress').addEventListener('change', (e) => {
        const n = Math.max(0, Math.min(600, Number(e.target.value) || 0));
        e.target.value = n;
        saveConfig({ videoJumpMinProgress: n });
      });

      // 作答方式 / 重试次数。重试次数要夹在 0~5，用户手输 999 会把接口打爆。
      $('answerMode').addEventListener('change', (e) => saveConfig({ answerMode: e.target.value }));
      $('answerRetries').addEventListener('change', (e) => {
        const n = Math.max(0, Math.min(5, Number(e.target.value) || 0));
        e.target.value = n;
        saveConfig({ answerRetries: n });
      });

      /*
       * 按模式显隐两套字段。
       *
       * 用 display 而不是重建 DOM —— 重建会把用户正在编辑的内容和滚动位置全丢掉。
       * 两套字段各存各的（apiUrl / apiUrlCustom），切换模式不会互相覆盖。
       */
      const applyMode = () => {
        const custom = CONFIG.apiMode === 'custom';
        $('aiFields').style.display = custom ? 'none' : 'block';
        $('customFields').style.display = custom ? 'block' : 'none';
        const badge = $('modeBadge');
        if (badge) badge.textContent = custom ? '自定义接口' : 'AI 直连';
      };

      $('apiMode').addEventListener('change', (e) => {
        saveConfig({ apiMode: e.target.value });
        applyMode();
        log(`答题模式切换为 ${e.target.value === 'custom' ? '自定义接口' : 'AI 直连'}`);
      });

      // 提示词改坏了能一键还原，否则用户只能去 Storage 里手改
      $('btnResetPrompt').onclick = () => {
        $('promptTemplate').value = DEFAULT_PROMPT;
        saveConfig({ promptTemplate: DEFAULT_PROMPT });
        this.flash('提示词已恢复默认');
      };

      applyMode();

      const collect = () => ({
        apiUrl: $('apiUrl').value.trim(),
        apiKey: $('apiKey').value.trim(),
        apiModel: $('apiModel').value.trim(),
        apiUrlFull: $('apiUrlFull').checked,
        promptTemplate: $('promptTemplate').value,
        apiUrlCustom: $('apiUrlCustom').value.trim(),
        apiMethod: $('apiMethod').value,
        apiHeaders: $('apiHeaders').value,
        apiBodyTemplate: $('apiBodyTemplate').value,
        respPath: $('respPath').value.trim(),
        respIdKey: $('respIdKey').value.trim() || 'id',
        respAnswerKey: $('respAnswerKey').value.trim() || 'answer',
        fallbackAnswer: $('fallbackAnswer').value.trim(),
        answerMode: $('answerMode').value,
        answerRetries: Math.max(0, Math.min(5, Number($('answerRetries').value) || 0)),
        dryRun: $('dryRun').checked,
        videoJumpToEnd: $('videoJumpToEnd').checked,
        videoJumpMinProgress: Math.max(0, Math.min(600, Number($('videoJumpMinProgress').value) || 0)),
        completeSelectors: $('completeSelectors').value.trim(),
        reportSettleMs: Math.max(0, Number($('reportSettleMs').value) || 0),
        completeWaitMs: Math.max(3000, Number($('completeWaitMs').value) || 25000),
      });

      $('btnSave').onclick = () => {
        saveConfig(collect());
        log('配置已保存 ✓');
        this.flash('已保存');
      };

      $('btnClearLog').onclick = () => {
        GM_setValue(LOG_KEY, []);
        $('logBox').textContent = '';
      };

      /*
       * 弹窗诊断。
       *
       * 用法：**让弹窗停在屏幕上**，再点这个按钮。
       * 它回答三个问题：脚本有没有找到提交按钮、有没有找到弹窗的确定按钮、
       * 页面上到底有哪些"看起来像弹层"的东西、以及脚本会对每个按钮做什么。
       *
       * 有它，"弹窗点不掉"就不再是一句抱怨，而是一条可以直接改选择器的证据。
       */
      $('btnPopup').onclick = () => {
        const box = $('logBox');
        const out = [];
        out.push(`── 弹窗诊断 ${new Date().toLocaleTimeString()} ──`);
        out.push(`地址: ${location.href.slice(0, 100)}`);
        out.push(`自动提交: ${CONFIG.autoSubmit ? '开' : '关（关了脚本不会自动点提交，弹窗要你自己点）'}`);
        out.push(`提交按钮: ${WorkModule.findSubmit() ? '已找到' : '**未找到**'}`);
        out.push(`弹窗确定按钮: ${WorkModule.findDialogConfirm() ? '已找到（会点它）' : '**没找到** ← 弹窗点不掉就是这个原因'}`);
        out.push(`整页兜底: ${WorkModule.findAnyConfirmButton() ? '能找到' : '找不到'}`);
        out.push('');
        out.push(...describePopups());
        const text = out.join('\n');
        box.textContent += '\n' + text + '\n';
        box.scrollTop = box.scrollHeight;
        pushLog('【弹窗诊断】\n' + text);
      };

      $('btnExportLog').onclick = () => this.exportLog();

      $('btnRefresh').onclick = () => {
        log('手动触发「重新执行」');
        // 广播给所有 frame —— 题目在子 frame 里，只调顶层的模块是没用的
        requestRetry();
        this.flash('已通知所有 frame 重新执行');
      };

      // 诊断：把运行时的关键指标打到日志区，用来判断有没有泄漏 / 卡在哪一步
      $('btnDiag').onclick = async () => {
        const v = VideoModule.video;
        const frames = document.querySelectorAll('iframe').length;
        const lines = [
          `脚本版本: ${SCRIPT_VERSION}`,
          `角色: ${CURRENT_ROLE}${isTop ? '（顶层）' : '（子 frame）'}`,
          `JS 堆占用: ${memInfo()}`,
          `活动定时器: ${Timers.count()}`,
          `熔断器: ${breaker.snapshot()}`,
          `日志队列: ${logQueue.length}`,
          '',
          `答题开关: ${CONFIG.answerEnabled ? '开' : '关（开了才会观察题目）'}`,
          `自动提交: ${CONFIG.autoSubmit ? '开' : '关（关了脚本不会自动点提交）'}`,
          `提交弹窗: ${WorkModule.findDialogConfirm() ? '检测到确定按钮（会点）' : '未检测到（弹窗出现时点「弹窗诊断」）'}`,
          `作答方式: ${CONFIG.answerMode === 'batch' ? '整卷一次' : `逐题作答（失败重试 ${Number(CONFIG.answerRetries) || 0} 次）`}`,
          `题旁进度: ${CONFIG.showProgress ? '开' : '关'}`,
          CONFIG.dryRun ? '演练模式: 开（只报告，不点击、不提交）' : '',
          `答题模块: ${WorkModule.running ? '正在请求中' : (WorkModule.watching ? `观察中，下次 ${WorkModule.wait}ms 后` : '未观察（循环已停）')}`,
          WorkModule.done
            ? `任务点: 已完成（${WorkModule.doneWhy}）→ 不再作答`
            : (WorkModule.chapterDoneByCatalog() ? '任务点: 目录显示已完成 → 暂停作答' : ''),
          `本任务点标识: ${taskKey() || '**识别不出**（URL 里没有 workId/jobid 之类的任务级参数）'}`,
          `提交记录: ${submitLatchReport()}`,
          WorkModule.req
            ? `请求进行中: 第 ${WorkModule.req.attempt}/${WorkModule.req.total} 次，已 ${Math.round((Date.now() - (WorkModule.req.attemptStartedAt || WorkModule.req.startedAt)) / 1000)}s`
            : '',
          `已处理题目: ${WorkModule.handled.size} 道`,
          WorkModule.lastApi ? `最近作答: ${WorkModule.lastApi}` : '',
          `题目容器命中: ${questionProbe()}`,
          `本 frame 内 iframe 数: ${frames}${frames && !WorkModule.findContainers().length ? '（题目可能在更深一层 frame 里）' : ''}`,
          '',
          `视频元素: ${v ? (v.isConnected ? '已接管且在文档中' : '已接管但已游离') : '未接管'}`,
          `视频状态: ${v ? (v.paused ? '暂停' : '播放中') + ` ${v.currentTime.toFixed(1)}/${isFinite(v.duration) ? v.duration.toFixed(1) : '?'}s @${v.playbackRate}x` : '-'}`,
          `跳到结尾: ${CONFIG.videoJumpToEnd
            ? (VideoModule.jumped
                ? '已跳到结尾，等待完成确认'
                : (VideoModule.jumpTried
                    ? `未跳（进度不足 ${Number(CONFIG.videoJumpMinProgress) || 0}s，按从头播处理）`
                    : '探测中'))
            : '已关闭'}`,
          `本 frame 完成标记: ${Completeness.markFound() ? '已出现' : '未出现'}`,
          `选择器命中: ${Completeness.describe()}`,
          `地址: ${location.href.slice(0, 80)}`,
        ];
        const box = $('logBox');
        const line = (s) => { box.textContent += s + '\n'; };
        const shown = lines.filter(Boolean);
        line('\n── 诊断 ' + new Date().toLocaleTimeString() + ' ──');
        shown.forEach(line);
        box.scrollTop = box.scrollHeight;

        // 再问一遍所有 frame 的状态 —— 这一步才是真正能定位问题的地方
        line('\n（正在收集各 frame 状态…）');
        box.scrollTop = box.scrollHeight;
        const reports = await collectFrameReports();
        const reportLines = renderFrameReports(reports);
        reportLines.forEach(line);
        box.scrollTop = box.scrollHeight;

        /*
         * 同时把报告写进日志缓冲。
         *
         * 日志区每 2 秒会用缓冲区的内容整体重写一次（textContent = ...），
         * 只往 DOM 里追加的话，下一条日志一到就被冲掉了 ——
         * 而这份报告正是要让用户复制出来发我的，被冲掉就白点了。
         * 整段作为一条写入，避免十几行把 120 条的缓冲冲爆。
         */
        pushLog('【诊断报告】\n' + shown.concat(reportLines).join('\n'));
      };

      /*
       * 结构诊断：把「脚本眼中的题目」原样打出来。
       *
       * 「诊断」回答的是"脚本在各 frame 里活着吗、卡在哪一步"；
       * 「结构诊断」回答的是另一个问题：**它到底从页面上读到了什么**。
       *
       * 这两个问题要分开问。脚本对超星页面的全部假设都压在 Q_SELECTORS 上，
       * 一旦对不上，症状就是"回填失败"—— 而那句话完全无法定位：是没抓到选项？
       * 字母对不上？还是题型判错了？这里把每题的实际解析结果摊开，
       * 让"选择器对不对"变成一件可以直接核对的事，不用再靠猜。
       *
       * 只读，不碰页面，随时可以点。
       */
      $('btnStruct').onclick = () => {
        const box = $('logBox');
        const line = (s) => { box.textContent += s + '\n'; };
        const out = [];

        out.push(`── 结构诊断 ${new Date().toLocaleTimeString()} ──`);
        out.push(`地址: ${location.href.slice(0, 100)}`);
        out.push(`题目容器命中: ${questionProbe()}`);

        const qs = WorkModule.collect();
        out.push(`解析出题目: ${qs.length} 道`);
        out.push('');

        if (!qs.length) {
          out.push('  ⚠ 一道题都没解析出来。两种可能：');
          out.push('    · 题目不在这个 frame 里 → 看「诊断」的 frame 列表，找题目×N 那一行');
          out.push('    · 题目在这个 frame 里但选择器对不上 → 用 F12 看真实类名，');
          out.push('      对照 Q_SELECTORS 的 container 那一行（.TiMu / .questionLi / .queBox …）');
        } else {
          for (const q of qs) {
            out.push(`  ${describeQuestion(q)}`);
            out.push('');
          }
          out.push('  怎么看这份结果：');
          out.push('    · 选项数=0        → 选项选择器没命中，抓不到选项');
          out.push('    · ⚠映射≠字母      → 有选项正文为空被过滤，或字母解析错位');
          out.push('    · 字母列表不对    → 页面用的不是 A/B/C/D 编号');
          out.push('    · 填空元素=0      → 判成了填空题但找不到输入框（题型判错）');
        }

        const text = out.join('\n');
        line('\n' + text);
        box.scrollTop = box.scrollHeight;
        // 同「诊断」：必须写进缓冲，否则下一次日志刷新就把它冲掉了
        pushLog('【结构诊断】\n' + text);
      };

      // 紧急停止：一键关掉所有功能并清空定时器，不用关标签页
      $('btnKill').onclick = () => {
        if (!confirm('紧急停止：将关闭全部自动功能并清除所有定时器。继续？')) return;
        saveConfig({
          videoEnabled: false, docEnabled: false, answerEnabled: false,
          autoNext: false, keepPlaying: false, logEnabled: false,
        });
        DocModule.stop();
        WorkModule.stop();
        Timers.clearAll();
        logQueue.length = 0;
        console.warn('[超星助手] 已紧急停止，定时器已清空');
        /*
         * clearAll() 把面板自己的日志轮询也一起清掉了，而且不会自己恢复 ——
         * 之后面板就再也不刷新日志，顶层「活动定时器」永远是 0，
         * 用户会觉得"面板也坏了"。所以这里必须把它重新注册回来。
         */
        this.startLogPoll(this.shadow);
      };

      /*
       * 测试 API。
       *
       * 这道模拟题是特意设计的：一道能靠常识答出的单选（1+1=?），
       * 用来同时验证「网络通不通 / 鉴权对不对 / 输出格式符不符合约定 / 能不能解析回来」。
       * 只验证到"取到数组"是不够的 —— 真正容易出错的是解析层，所以 AI 模式会把
       * 解析结果一并打出来。
       */
      $('btnTest').onclick = async () => {
        saveConfig(collect());
        const box = $('logBox');
        const line = (s) => { box.textContent += s + '\n'; box.scrollTop = box.scrollHeight; };
        const fake = [{
          id: 'q1', type: 'single', question: '1+1=?',
          options: [{ key: 'A', text: '1' }, { key: 'B', text: '2' }],
        }];
        const payload = JSON.stringify(fake);

        try {
          if (CONFIG.apiMode === 'custom') {
            line('[测试] 自定义接口模式，发送模拟题目...');
            const tpl = CONFIG.apiBodyTemplate || '{{questions}}';
            const body = tpl.includes('{{questions}}') ? tpl.replace('{{questions}}', payload) : payload;
            line(`[测试] 正在请求 ${redactUrl(CONFIG.apiUrlCustom)} …（单次超时 ${Math.round((CONFIG.apiTimeout || 30000) / 1000)}s，超时不重试）`);
            const t0 = Date.now();
            const res = await request({
              url: CONFIG.apiUrlCustom,
              method: CONFIG.apiMethod || 'POST',
              headers: WorkModule.parseHeaders(),
              data: body,
              timeout: CONFIG.apiTimeout,
            });
            line(`[测试] HTTP ${res.status}（耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
            line('[测试] ' + (res.responseText || '').slice(0, 400));
            const json = JSON.parse(res.responseText);
            const list = deepGet(json, CONFIG.respPath);
            line(Array.isArray(list) ? '[测试] ✓ 成功取到结果数组' : '[测试] ✗ 响应路径取不到数组，请调整「响应路径」');
            return;
          }

          const endpoint = resolveChatEndpoint(CONFIG.apiUrl, CONFIG.apiUrlFull);
          if (!endpoint) return line('[测试] ✗ 还没填 API 地址');
          line(`[测试] AI 模式 · 端点 ${endpoint} · 模型 ${CONFIG.apiModel || 'gpt-4o-mini'}`);
          line(`[测试] 密钥 ${CONFIG.apiKey ? `已填（${CONFIG.apiKey.trim().length} 字符）` : '未填'}`);

          line(`[测试] 正在请求 ${redactUrl(endpoint)} …（单次超时 ${Math.round((CONFIG.apiTimeout || 30000) / 1000)}s，超时不重试）`);
          const headers = { 'Content-Type': 'application/json' };
          if (CONFIG.apiKey) headers.Authorization = 'Bearer ' + CONFIG.apiKey.trim();
          const t0 = Date.now();
          const res = await request({
            url: endpoint,
            method: 'POST',
            headers,
            data: JSON.stringify({
              model: CONFIG.apiModel || 'gpt-4o-mini',
              messages: [
                { role: 'system', content: String(CONFIG.promptTemplate || '').trim() || DEFAULT_PROMPT },
                { role: 'user', content: '题目如下（JSON 数组）：\n' + payload },
              ],
              temperature: 0.2,
              stream: false,
            }),
            timeout: CONFIG.apiTimeout,
          });

          line(`[测试] HTTP ${res.status}（耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s）`);
          let json = null;
          try { json = JSON.parse(res.responseText); } catch (e) { /* 非 JSON */ }
          const text = json ? pickModelText(json) : String(res.responseText || '');
          if (!text) {
            line('[测试] ✗ 取不到模型输出。原始响应: ' + String(res.responseText || '').slice(0, 300));
            line('[测试]   常见原因：地址没补成 /chat/completions、密钥无效、或该网关不兼容 OpenAI 格式');
            return;
          }
          line('[测试] 模型输出: ' + text.slice(0, 300));
          const out = resolveAnswers(text, fake);
          line(`[测试] 解析结果: ${JSON.stringify(out)}`);
          line(out.q1
            ? `[测试] ✓ 全链路通过（解析出 "q1" → "${out.q1}"）`
            : '[测试] ✗ 解析不出答案，提示词的输出格式约定可能被改坏了（可点「恢复默认」）');
        } catch (e) {
          // 走和正式答题同一套翻译，保证"测试"和"实际答题"给出一样的排查建议
          const target = CONFIG.apiMode === 'custom' ? CONFIG.apiUrlCustom : CONFIG.apiUrl;
          line('[测试] ✗ ' + WorkModule.explainApiError(e, target));
        }
      };
    },

    flash(text) {
      const box = this.body.querySelector('#logBox');
      if (!box) return;
      box.textContent += `[${new Date().toLocaleTimeString()}] ${text}\n`;
      box.scrollTop = box.scrollHeight;
    },

    /*
     * 导出日志为 .txt 文件。
     *
     * 导出前**必须脱敏**：日志里会记录完整的 API 地址（可能带 token），
     * 配置里还有 Authorization 头。用户拿这个文件去排查问题时，
     * 不该顺带把自己的密钥一起交出去。
     */
    exportLog() {
      const redact = (s) => String(s == null ? '' : s)
        // 请求头里的密钥类字段
        .replace(/("(?:authorization|cookie|x-api-key|api[_-]?key|token|secret)"\s*:\s*")[^"]*(")/gi, '$1***$2')
        // URL query 里的密钥
        .replace(/([?&](?:key|token|secret|api[_-]?key|access[_-]?token)=)[^&\s"']*/gi, '$1***')
        // Bearer 后面的一长串
        .replace(/(Bearer\s+)[A-Za-z0-9._-]{8,}/gi, '$1***')
        /*
         * 裸奔的 sk- 开头密钥。
         * 前面三条都要求密钥处在一个"有字段名/前缀可依托"的位置，但如果某个中转站
         * 把密钥回显在错误信息里（"invalid key: sk-xxx"），就漏出去了。
         * 这条是兜底。误伤面很小 —— 正常日志里不会出现 sk- 加 12 位以上的串。
         */
        .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, 'sk-***');

      let cfg;
      try {
        cfg = JSON.parse(JSON.stringify(CONFIG));
      } catch (e) {
        cfg = {};
      }
      cfg.apiHeaders = redact(cfg.apiHeaders);
      cfg.apiUrl = redact(cfg.apiUrl);
      cfg.apiUrlCustom = redact(cfg.apiUrlCustom);
      // 密钥单独处理：它是纯裸串，没有 "Bearer " 或字段名可以依托，正则匹配不到，
      // 所以直接按字段名整体打码，不做任何猜测。
      if (cfg.apiKey) cfg.apiKey = '***';

      const buf = GM_getValue(LOG_KEY, []);
      const head = [
        '# 超星助手 运行日志',
        `导出时间: ${new Date().toLocaleString()}`,
        `脚本版本: ${SCRIPT_VERSION}`,
        `当前角色: ${CURRENT_ROLE}`,
        `页面地址: ${location.href}`,
        `浏览器: ${navigator.userAgent}`,
        `活动定时器: ${Timers.count()}`,
        `熔断器: ${breaker.snapshot()}`,
        `JS 堆占用: ${memInfo()}`,
        '',
        '--- 配置（密钥已打码） ---',
        JSON.stringify(cfg, null, 2),
        '',
        `--- 日志（${buf.length} 条，所有 frame 混合） ---`,
      ];
      const text = head.concat(buf.map(redact)).join('\n');

      try {
        const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `chaoxing-log-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.txt`;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        // 立刻 revoke 会让部分浏览器下载失败，延后释放
        Timers.after(() => URL.revokeObjectURL(url), 5000);
        this.flash('日志已导出（密钥已打码）');
      } catch (e) {
        warn('导出日志失败:', e.message || e);
        this.flash('导出失败：' + (e.message || e));
      }
    },

    /*
     * 拖动。全局 mousemove 只在按住标题栏期间才挂上 ——
     * v1.0.0 是常驻监听，虽然回调第一行就 return，但每次鼠标移动都要进一次函数。
     */
    makeDraggable(handle) {
      let sx = 0, sy = 0, ox = 0, oy = 0;

      const onMove = (e) => {
        this.root.style.left = Math.max(0, ox + e.clientX - sx) + 'px';
        this.root.style.top = Math.max(0, oy + e.clientY - sy) + 'px';
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('mouseup', onUp, true);
      };

      handle.addEventListener('mousedown', (e) => {
        if (e.target.tagName === 'BUTTON') return;
        const r = this.root.getBoundingClientRect();
        sx = e.clientX; sy = e.clientY;
        ox = r.left; oy = r.top;
        this.root.style.right = 'auto';
        this.root.style.bottom = 'auto';
        this.root.style.left = ox + 'px';
        this.root.style.top = oy + 'px';
        document.addEventListener('mousemove', onMove, true);
        document.addEventListener('mouseup', onUp, true);
        e.preventDefault();
      });
    },

    setDot(on) {
      const d = this.root?.querySelector('#dot');
      if (d) d.classList.toggle('off', !on);
    },
  };

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (m) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]
    ));
  }

  /* ============================================================
   * 8. 自动下一节（顶层）
   * ============================================================ */

  /*
   * 目录（章节列表）里的章节项。
   *
   * ⚠️ 注意这几个选择器**互相嵌套**：`.catalog_points_ul li` 匹配的 `li` 内部
   * 往往就是 `.posCatalog_level a` 匹配的那个 `a`。所以 querySelectorAll 的结果里
   * 同一章会出现两项（外层 + 内层），文档序上紧挨着 —— 取"下一个"时必须跳过，
   * 见 nextCatalogItem()。
   */
  const CATALOG_SELECTORS = [
    '.posCatalog_select', '.chapter_item', '.catalog_points_ul li', '.posCatalog_level a',
  ];

  /*
   * 自动下一节。
   *
   * 判定只有一条：**当前章节的任务点是否已完成** —— 看超星自己画在目录项上的完成标记。
   * 显示已完成 → 模拟点击「下一节」；没显示 → 什么都不做，继续等。
   *
   * 为什么只认目录标记，不去问子 frame"你播完了吗"：
   *   完成标记是超星**根据服务器返回的状态**渲染的，是唯一权威依据；
   *   "媒体播完"只是本地推断 —— 超星还要把进度上报、服务器确认，中间隔着好几秒，
   *   而且经常失败。顶层本来就看得见目录，没必要绕一圈。
   *   见文件头注释第 4 条。
   *
   * 为什么不需要"先武装、再判断"：
   *   完成标记是**持久**的，所以"目录说完成"本身证明不了"刚刚做完"。
   *   但那正是这个开关的语义 —— 打开「自动下一节」＝ 已完成的任务点不要停，
   *   一路跳到第一个没做完的地方。想在某章停下来复看，把开关关掉即可。
   *   上面那段语义就是这个开关的代价，别在代码里偷偷加回"必须先收到信号"这类闸门。
   */
  const NextModule = {
    lastJumpAt: 0,      // 最近一次跳转的时间（冷却用）
    loopTimer: null,    // 唯一的主循环
    lastDone: null,     // 上一次广播给子 frame 的目录状态
    lastDoneAt: 0,      // 上次广播的时间（心跳刷新用）
    lastTabSwitchAt: 0, // 最近一次"章节内换任务点"的时间（冷却用）
    holdKey: '',        // 上次记过的"不推进原因"（同一个原因只打一次日志）
    seqVideos: null,    // 上次顺序编排时的视频列表（判断"编排结果变没变"）
    seqActiveIdx: -1,   // 上次顺序编排选中的下标（-1 = 全部已到完成线）

    /*
     * 「超星标记迟到」的宽限时长。
     *
     * 完成判据以超星画的 ans-job-finished 为准（见 videoTaskDone）。万一超星
     * 哪天把这个类名改掉、而容器结构没变，判据就会永远返回"没完成" →
     * 视频播到末尾也不放行 → **永久卡死**。所以留一道阀：视频**真的播到末尾**
     * 了、超星在这段时间内还是没画标记，就退回位置判据放行，并打一条告警。
     *
     * 45 秒是"够慢的服务器也早该上报完"的量级；关键是它只对**已到末尾**的视频
     * 生效 —— 位置刚到 90%、还在播的那种绝不放行（那正是真机 6.1 的 bug）。
     */
    MARK_GRACE_MS: 45000,

    POLL_MS: 3000,        // 检查间隔
    JUMP_COOLDOWN: 10000, // 跳转冷却：点完这一下，10 秒内不再点（防连点 / 连跳两节）
    HEARTBEAT_MS: 60000,  // 目录状态没变也要这么久重发一次（见 broadcastChapterDone）
    /*
     * 章节内换任务点的冷却。
     * 比跳节的冷却短（换任务点本来就更频繁），但仍要防连点：
     * 一次点空（标签在切换动画里、DOM 刚重建）不该让循环每 3 秒猛戳一次。
     */
    TAB_SWITCH_COOLDOWN: 8000,

    start() {
      if (!CONFIG.autoNext) {
        log('「自动下一节」是关的 —— 只广播目录状态，不做跳转');
      }
      this.loop(3000);
    },

    /**
     * 唯一的主循环：查完成状态 → 决定跳不跳；顺便把目录状态广播给子 frame。
     *
     * 只有一个循环、一个判断点，所以"什么时候能跳"不会有第二条路径各跳一次
     * （v1.4.14 之前的 bug：完成信号和页面扫描两条路互不感知，先后触发会连点两次
     * 「下一节」，直接跳过一个任务点）。
     */
    loop(firstDelay) {
      if (this.loopTimer) Timers.clear(this.loopTimer);
      const tick = () => {
        try {
          this.check();
        } catch (e) {
          // 和答题的观察循环同一个原则：一次异常绝不能把长期循环整个杀死
          warn('下一节检查异常（已忽略，继续观察）:', e.message || e);
        }
        this.loopTimer = Timers.after(tick, this.POLL_MS);
      };
      this.loopTimer = Timers.after(tick, firstDelay == null ? this.POLL_MS : firstDelay);
    },

    check() {
      const item = this.currentCatalogItem();

      /*
       * 广播目录状态（答题模块据此暂停，见 broadcastChapterDone）。
       * 读不到当前项时**保持上一次的状态** —— 广播的是"这个章节完没完成"，
       * 读不到 ≠ 未完成，别把它当成一次状态变化发出去。
       */
      if (item) this.broadcastChapterDone(Completeness.markFound(item));

      /*
       * ★ 顺序播放编排 —— **无条件**跑，故意放在 autoNext / cooldown 判断之前。
       *
       * 它管的是"当前标签下的多个视频按什么次序播"，跟"要不要跳转"是两件事，
       * 所以不能被那两个开关挡住：
       *   · 「自动下一节」关掉时，用户是不想让它跳章，不是不想让视频播完；
       *   · 跳转冷却期内（刚点完一次）视频照样得继续播；
       *   · 当前已经是**最后一个标签**时，advanceTaskPoint() 会直接 return，
       *     contentReachedDone() 根本不会被调到 —— 如果编排挂在那条链上，
       *     最后一个标签里的多视频就永远没人推。
       *
       * 包 try 的理由和主循环一样：编排出一次异常不该把"跳不跳"的判断一起带走。
       */
      try { this.sequenceVideos(); } catch (e) {
        warn('视频顺序编排异常（已忽略，继续观察）:', (e && e.message) || e);
      }

      if (!CONFIG.autoNext) return;
      if (this.cooldown()) return;

      if (this.chapterTaskDone(item)) {
        this.goNext();
        return;
      }

      /*
       * 整章还没完成 —— 但**章节内部**可能还有别的任务点没做。
       * 这一步专门管它，见 advanceTaskPoint()。
       * 不放在 chapterTaskDone 之前：整章已完成时直接跳节，没必要再碰任务点标签。
       */
      this.advanceTaskPoint(item);
    },

    /**
     * 当前章节的任务点是否已完成。
     *
     * **只看当前高亮的那个目录项**，不看整页：目录里其它章节的完成标记是常驻的，
     * 拿整页去查等于"目录里有任何一章做完就跳"。
     *
     * 认不出当前章节（目录没渲染 / 选择器对不上）→ 返回 false，按未完成处理。
     * 宁可不动，也不抢跑 —— 和"章节导航按钮是常驻的，所以不能拿它当依据"是同一条原则。
     */
    chapterTaskDone(item) {
      const n = item || this.currentCatalogItem();
      if (!n) return false;
      try { return Completeness.markFound(n); } catch (e) { return false; }
    },

    /* ------------------------------------------------------------
     * 章节内的任务点推进
     *
     * 一个章节里可能有**多个任务点**（视频 / 章节测验 / 文档…），每个对应页面
     * 顶部 #prev_tab 里的一个标签。超星只在**整章**做完时才在目录项上画
     * icon_Completed —— 在那之前 chapterTaskDone() 一直是 false，goNext() 永远
     * 不会动。于是出现这个很别扭的状态：视频早就做完了，脚本却一直停在视频
     * 标签上，既不播也不切，用户得自己手点「章节测验」。
     *
     * 真机现场（2026-09-22，3.3「推进国家安全体系和能力现代化」）：
     *   目录项「1个待完成任务点」、标签 = 视频 + 章节测验、
     *   视频已到 100% 且**可以拖拽**（＝该任务点已完成，见 BUGS.md 第 6 条），
     *   而脚本从 13:18:44 到 13:21:47 只打心跳，一个动作都没有。
     *
     * 判据只用超星自己的两个数据，不做任何"猜"：
     *
     *   jobUnfinishCount   目录项里那个隐藏 input，**未完成任务点数**（权威）
     *   #prev_tab li       任务点标签列表，顺序就是超星的任务点顺序
     *
     *   已完成的任务点数 = 标签数 - 未完成数
     *
     * 按顺序做任务点时，已完成的就是前面那些 —— 当前标签的下标只要落在这个
     * 区间里，就说明它已经做完了，该往后走。
     * 真机对照：4.3 的任务点从「2个」变成「1个」时，它的标签正好也是 2 个。
     *
     * ⚠️ **但"标签数 == 任务点数"不总成立**（2026-09-23 真机 6.1 实测）：
     *   节 6.1「坚持以经济安全为基础的科学内涵」有 3 个任务点
     *   （两个视频 + 一个章节测验），页面上却只有 2 个标签：
     *
     *     dct1 「视频」    ← 里面挂着**两个**视频任务点，各一个播放器
     *     dct2 「章节测验」
     *
     *   目录项：<input class="jobUnfinishCount" value="3">（"3个待完成任务点"）
     *   → 上面那条减法算出来是 2 - 3 = **-1**。
     *
     *   所以"当前标签是否真做完"不能只看减法，必须再逐个看标签里的内容 ——
     *   见 contentReachedDone() / activeTabVideos()。
     * ------------------------------------------------------------ */

    /**
     * 章节内推进到下一个任务点。
     *
     * ⚠️ 为什么还要 contentReachedDone() 那层确认：
     * 上面那个减法成立的前提是「标签数 == 任务点数」，而真机 6.1 就不是
     * （2 个标签 / 3 个任务点）。只要这个前提破了，减法就会把"还没做完的视频"
     * 算成"已完成"，脚本会在视频播到一半时把它切走 —— 而脚本只往前走、
     * 不往回切，那个视频任务点就废了。
     *
     * 所以视频标签必须**真的播到超星的完成线（90%）**才放行，而且标签下
     * **每一个**视频任务点都要到线。这条线是超星自己写在页面上的：
     * 「观看时长需 ≥ 总时长的 90%」。
     */
    advanceTaskPoint(item) {
      const count = this.unfinishCount(item);
      if (count == null || count <= 0) return;   // 读不到计数 / 整章已完成 → 交给 goNext

      const tabs = this.taskTabs();
      if (tabs.length <= 1) return;              // 只有一个任务点，没有"下一个"可切

      const curIdx = this.activeTaskIndex(tabs);
      if (curIdx < 0) return;                    // 认不出当前标签，宁可不动
      if (curIdx >= tabs.length - 1) return;     // 已经是最后一个，后面没有可切的

      if (!this.taskDone(count, tabs, curIdx)) return;
      if (Date.now() - this.lastTabSwitchAt < this.TAB_SWITCH_COOLDOWN) return;

      this.lastTabSwitchAt = Date.now();
      const next = tabs[curIdx + 1];
      /*
       * 措辞分清楚「标签数」和「任务点数」—— 它们不总是相等（真机 6.1：2 个标签
       * 对应 3 个任务点）。原来写"本章共 N 个任务点"是在用标签数冒充任务点数，
       * 排查时会被这个数字带偏。
       */
      log(`当前任务点已完成（本章 ${tabs.length} 个标签，还剩 ${count} 个任务点未完成），` +
          `切到下一个: ${this.tabLabel(next)}`);
      this.click(next);
    },

    /**
     * 当前激活的那个任务点是否已经完成。
     *
     * 已完成的任务点数 = 标签数 - 未完成数。按顺序做任务点时，已完成的就是前面
     * 那些 —— 当前下标落在这个区间里，才说明它做完了。
     *
     * 这一条同时盖住了"一个都没完成"：那时 doneCount ≤ 0、区间为空，而 curIdx
     * 恒 ≥ 0（advanceTaskPoint 已经挡掉了认不出当前标签的情况），任何下标都进不去。
     * 所以不需要再单独写一句 `doneCount > 0` —— 写了也是死代码。
     *
     * ⚠️ 这条减法隐含一个前提：**标签数 == 任务点数**。真机 6.1 不是这个形状 ——
     * 3 个任务点（两个视频 + 一个测验）在页面上只对应 2 个标签，于是这里的
     * "已完成数"会是 -1。它对"现在能不能切"仍然给出对的答案（超星把同一类的
     * 任务点并成一个标签，而计数按任务点递减），但**不能**拿它当"当前标签真做完了吗"
     * 的唯一依据 —— 那件事由 contentReachedDone() 负责，它会把标签下的
     * 每一个视频任务点都过一遍完成线。两者是"与"的关系，缺一不可：
     *   · 只有减法 → 第一个视频播完就替第二个签字（提前切走，任务点作废）
     *   · 只有内容判据 → 视频到 90% 就切，不等超星把进度确认下来
     *
     * @param {number} count  本章未完成任务点数
     * @param {Array}  tabs   任务点标签列表
     * @param {number} curIdx 当前标签下标
     */
    taskDone(count, tabs, curIdx) {
      const doneCount = tabs.length - count;   // 已完成的任务点数
      if (!(curIdx < doneCount)) return false; // 当前这个还没轮到"已完成"的区间
      return this.contentReachedDone(tabs[curIdx]);
    },

    /**
     * 当前标签里的内容是否到了完成线。
     *
     * 只对**视频**做实质判断：该标签下的**每一个**视频任务点都要 ≥ 90%
     * （超星写在任务点上的完成条件）。
     *
     * 判据的第一层不是"有没有 video"，而是**当前标签是不是视频** ——
     * 顺序反过来的话，"找不到 video"就没法区分下面这两种情形：
     *   · 当前本来就不是视频标签（测验 / 文档）→ 该放行，各自模块负责
     *   · 当前是视频标签，只是播放器还没挂上来 → **绝不能放行**
     *
     * 后者是 v1.5.5 的漏网之鱼。真机症状：手动点回视频标签，8 秒后脚本
     * 又把它切回测验，内容 frame 始终 (not found)。原因是刚切到视频标签的
     * 那一瞬间 frame 还没挂载，这里读不到 video，旧代码直接 return true，
     * 脚本立刻又切走 —— 切回去、切过来，那个视频任务点永远做不完。
     *
     * "是视频、却读不到时长"（元数据还没加载）同样不放行：
     * 这时候"播完了没有"无从判断，放行就等于把没播完的视频切走。
     *
     * @param {Element} tab 当前激活的任务点标签；不传则自己找
     */
    contentReachedDone(tab) {
      const t = tab || this.activeTab();

      /*
       * 非视频标签（测验 / 文档 / 阅读）：不在这里抢判，各自模块负责。
       * 这一条必须排在最前面 —— 顺序反过来的话，"找不到 video"就没法区分
       * "本来就不是视频标签"和"是视频标签、只是播放器还没挂上来"，
       * 而后者恰恰是 v1.5.5 把视频标签误切走的原因。
       */
      if (!this.isVideoTab(t)) return true;

      const tasks = this.activeTabVideoTasks();
      if (!tasks.length) {
        this.noteHold('no-player', '视频标签下还没找到播放器，先不切走（等它挂上来）');
        return false;
      }

      /*
       * ★ 一个「视频」标签下可能挂着**多个视频任务点**。
       *
       * 真机 6.1「坚持以经济安全为基础的科学内涵」就是这个形状：3 个任务点
       * （两个视频 + 一个章节测验）在页面上只有 2 个标签 —— 两个视频同属
       * 「视频」标签，各自一个 div.ans-attach-ct.videoContainer + iframe + <video>，
       * 都写着"完成条件 观看时长需 ≥ 总时长的 90%"。
       *
       * 所以必须**逐个**过完成线。只判第一个（v1.5.5~v1.5.8 的写法：
       * activeContentWindow() + querySelector('video')）的话，"已经播完的那个"
       * 会替"还没播的那个"签字 —— 脚本于是提前切走，而它只往前走、不往回切，
       * 那个视频任务点就永远做不完了。
       */
      const behind = [];
      for (let i = 0; i < tasks.length; i++) {
        if (!this.videoTaskDone(tasks[i])) behind.push(i + 1);
      }
      if (behind.length) {
        this.noteHold('video-pending',
          `本标签下 ${tasks.length} 个视频任务点里还有 ${behind.length} 个没到完成线` +
          `（第 ${behind.join('、')} 个），先不切走`);
        return false;
      }

      this.holdKey = '';
      return true;
    },

    /**
     * **位置判据**：这个视频的播放位置到没到超星写明的完成线（90%）。
     *
     * ⚠️ v1.6.1 起它**不再是主判据**，只在两种情况下用：
     *   1) 认不出超星的任务点容器结构（超星改版）→ 退化成 v1.5.9 的行为；
     *   2) 视频真的播到末尾、超星却迟迟不画标记，且已过 MARK_GRACE_MS 宽限。
     *
     * **为什么不能拿它当主判据**（真机 6.1 实测，2026-09-23）：
     * 超星判的是**累计观看时长**，而这里是**播放位置**，两者会分叉 ——
     * 现场两个视频位置都在 90% 以上，超星只认了第二个：
     *
     *   视频一 1387.5s @ 1255.6s = 90.5%  → 容器上**没有** ans-job-finished（未完成）
     *   视频二 1480.5s @ 1334.0s = 90.1%  → 容器上有 ans-job-finished（已完成）
     *
     * 拿位置当判据的后果是"伪完成"：脚本以为做完了，于是停手不播，
     * 而超星还差着观看时长 → 任务点永远做不完。见 BUGS.md 第 12 条。
     *
     * 已播完（ended）也算：有些播放器最后一帧不把 currentTime 推到 duration，
     * 单看比例会差那么一点点。
     */
    positionReachedDone(v) {
      if (!v) return false;
      try {
        if (v.ended) return true;
        if (!isFinite(v.duration) || v.duration <= 0) return false;
        return v.currentTime / v.duration >= 0.9;
      } catch (e) { return false; }
    },

    /**
     * 这个播放器是不是**真的播到末尾**了（不是"过了 90%"，是到尾巴）。
     *
     * 用来给 MARK_GRACE_MS 那道阀定条件：只有已经播到末尾的视频才允许
     * "等不到超星标记就先放行" —— 位置刚到 90%、还在播的绝不放行。
     *
     * 和 VideoModule.reachedEnd() 是同一条线（0.5 秒容差），但那一个是子 frame
     * 里的方法，顶层调不到，所以这里另写一份。两边都只改一处时记得对齐。
     */
    atMediaEnd(v) {
      if (!v) return false;
      try {
        if (v.ended) return true;
        if (!isFinite(v.duration) || v.duration <= 0) return false;
        return v.currentTime >= v.duration - 0.5;
      } catch (e) { return false; }
    },

    /**
     * 一个**视频任务点**到底做完了没有。
     *
     * ★ 判据只有一条是权威的：**超星自己画在任务点容器上的 `ans-job-finished`**。
     *   （真机实测：`div.ans-attach-ct.videoContainer` 完成时变成
     *    `div.ans-attach-ct.videoContainer ans-job-finished`；同一章里已完成的那个
     *    有、没完成的那个没有 —— 是能区分开的。）
     *
     * ⚠️ 别用 `span.ans-job-icon.ans-job-icon-clear`：真机两个视频**都有**这个类，
     *    它不区分完成与否，是个诱饵。
     *
     * 三档语义：
     *   finished === true   超星说完成了 → 完成（唯一可信的"完成"）
     *   finished === null   认不出超星的容器/标记（改版）→ 退回位置判据
     *   finished === false  超星说没完成 → **没完成**，继续播
     *
     * 第三档是 v1.6.1 修的那个 bug 的核心：位置过了 90% 但超星没认时，
     * 旧代码直接算"完成"，于是停手；现在要继续播，直到超星认账。
     *
     * ★ 唯一的例外（防死锁）：视频**已经播到末尾**、超星却始终不画标记 ——
     * 那多半是标记机制变了，等满 MARK_GRACE_MS 就放行 + 告警。
     * 放行结果记在元素上（`gaveUp`），所以只会告警一次，不会反复横跳。
     *
     * 副作用：会在元素上写 `__cxMarkWait`（首次进入"位置已到线但超星没认"的时刻）。
     * 这是有意的 —— 它要跨多次调用计时，而 check() 每 3 秒就会问一次。
     *
     * @param {{video: HTMLVideoElement|null, container: Element|null, finished: boolean|null}} task
     */
    videoTaskDone(task) {
      if (!task) return false;
      const v = task.video;

      // 1) 超星认了 → 完成。顺手清掉等待状态（免得它一直挂着）
      if (task.finished === true) { this.resetMarkWait(task); return true; }

      // 2) 认不出超星的结构 → 退回 v1.5.9 的位置判据（宁可退化，也不要死锁）
      if (task.finished === null) return this.positionReachedDone(v);

      // 3) 超星说没完成，而且位置也没到线 → 明确没完成
      if (!this.positionReachedDone(v)) { this.resetMarkWait(task); return false; }

      /*
       * 4) 位置过了 90%，但超星没认 —— **这不是完成**。
       *
       * 这就是 v1.6.1 修的那一条：旧代码在这里返回 true，于是脚本停止播放、
       * 判"本标签已完成"、切走标签，而超星那边观看时长还没记够。
       */
      if (!this.atMediaEnd(v)) { this.resetMarkWait(task); return false; }

      // 5) 已经播到末尾了、超星还是不画标记 → 给一段宽限，超时就放行（防死锁）
      const st = this.markWait(task);
      if (!st) return this.positionReachedDone(v);   // 状态挂不上（少见）→ 保守退化
      if (st.gaveUp) return true;
      if (!st.at) st.at = Date.now();
      if (Date.now() - st.at >= this.MARK_GRACE_MS) {
        st.gaveUp = true;
        log(`⚠ 视频已播到末尾，但超星 ${Math.round(this.MARK_GRACE_MS / 1000)} 秒内都没画` +
            '「已完成」标记（ans-job-finished）—— 可能超星改了页面结构，' +
            '先按播放位置放行。这条只影响本次判断，不影响别处');
        return true;
      }
      return false;
    },

    /**
     * 读"位置已到线但超星还没认"的等待状态，没有就建一个。
     *
     * 挂在**任务点容器**上（没有容器时挂在 video 上）—— 和 `__cxSeq` 同一个理由：
     * 一个 frame 里可能挂着多个视频任务点，用模块级字段分不开。
     */
    markWait(task) {
      const el = (task && (task.container || task.video)) || null;
      if (!el) return null;
      try {
        if (!el.__cxMarkWait || typeof el.__cxMarkWait !== 'object') {
          el.__cxMarkWait = { at: 0, gaveUp: false };
        }
        return el.__cxMarkWait;
      } catch (e) { return null; }   // 元素上挂不了属性（少见）→ 调用方退化处理
    },

    /** 清掉等待状态（视频没到线、或超星已经认了的时候） */
    resetMarkWait(task) {
      const el = (task && (task.container || task.video)) || null;
      if (!el) return;
      try { delete el.__cxMarkWait; } catch (e) { /* 挂不上就没什么可清的 */ }
    },

    /**
     * 当前标签下**所有**的视频任务点（可能不止一个）。
     *
     * 为什么不能只取"第一个含 video 的 frame 里的第一个 video"：
     * 一个标签下可以挂多个视频任务点（见 contentReachedDone 里 6.1 的实测），
     * 而 DFS 找到的第一个 frame 未必是当前标签的那个。
     *
     * 两道过滤：
     *   · 排除**已知的**小播放器（时长 ≤ 5 秒的广告 / 预览）——
     *     和 VideoModule.trackedVideos() 同一条线；时长还没读到的**不排除**（可能是任务点还在加载）
     *   · **看得见** —— 切到别的标签时超星会把内容藏起来，藏着的那些不属于当前标签。
     *     这一条让"每个视频一个标签"的章节也不会被别的标签的播放器带偏。
     *     量不到尺寸时按"可见"处理：宁可多算一个，也不要漏成"没有播放器"。
     */
    activeTabVideos() {
      const out = [];
      const walk = (w) => {
        let d;
        try { d = w.document; } catch (e) { return; }   // 跨域
        if (!d) return;

        let vs = [];
        try { vs = Array.from(d.querySelectorAll('video')); } catch (e) { vs = []; }
        for (const v of vs) {
          /*
           * 只排除**已知的**小播放器（广告 / 预览）：时长已经读到、而且 ≤ 5 秒。
           * 和 VideoModule.trackedVideos() 同一条线。
           *
           * 时长**还不知道**的绝不能排除 —— 那多半是任务点播放器还在加载。
           * 排除它就等于给"还没播的那个"放行，正好踩回我们要修的那个坑。
           * 它会在 videoDone() 里被判成"没到完成线"，于是这里先不切（保守）。
           */
          let dur = NaN;
          try { dur = Number(v.duration); } catch (e) { dur = NaN; }
          if (isFinite(dur) && dur <= 5) continue;

          let vis = true;
          try {
            const r = v.getBoundingClientRect();
            vis = !!(r && r.width > 0 && r.height > 0);
          } catch (e) { vis = true; }
          if (!vis) continue;
          out.push(v);
        }

        let fs = [];
        try { fs = Array.from(d.querySelectorAll('iframe')); } catch (e) { return; }
        for (const f of fs) {
          try {
            if (f.contentWindow && f.contentWindow.document) walk(f.contentWindow);
          } catch (e) { /* 跨域子 frame，跳过 */ }
        }
      };
      walk((document && document.defaultView) || window);
      return out;
    },

    /* ------------------------------------------------------------
     * ★ v1.6.1：完成判据换成超星自己的标记
     *
     * v1.5.9 起的判据是 `currentTime / duration >= 0.9`（**播放位置**），
     * 而超星判的是**累计观看时长** —— 两者会分叉。真机 6.1（2026-09-23 实测）
     * 就是分叉的极端样本：两个视频位置都在 90% 以上，超星只认了第二个。
     *
     *   视频一 1387.5s @ 1255.6s = 90.5%  容器 class = "ans-attach-ct videoContainer"
     *   视频二 1480.5s @ 1334.0s = 90.1%  容器 class = "… videoContainer ans-job-finished"
     *   旁证：input.jobUnfinishCount = 2（3 个任务点里剩 2 个 = 视频一 + 章节测验）
     *
     * 拿位置当判据的后果是**伪完成**：脚本以为做完了 → 停止播放 → 判"本标签已完成"
     * → 超星永远收不到剩下的观看时长 → 章节永远完不成（脚本只往前走，不往回切）。
     *
     * 所以：判据以容器上的 `ans-job-finished` 为准，位置比例只作兜底。
     * 详见 videoTaskDone()。
     * ------------------------------------------------------------ */

    /**
     * 当前标签下的**视频任务点**列表 —— 每个都带着"超星认没认它完成"。
     *
     * 返回 `[{ video, container, finished }]`，顺序就是**超星列任务点的顺序**：
     *   video     该任务点的播放器；容器在、播放器还没挂上来时是 null
     *   container 超星的任务点容器（div.ans-attach-ct）；认不出时是 null
     *   finished  容器上有 ans-job-finished → true；没有 → false；
     *             连容器都认不出来 → null（"不知道"，退回位置判据）
     *
     * 为什么按**容器**收，而不是按 video 收：`ans-job-finished` 画在容器上，
     * 而 video 在容器内部那个 iframe 里（跨 frame）。从 video 反查容器要跨 frame
     * 往上走，做不到；从容器往下钻 iframe 是一步的事。
     *
     * 三条收集规则，都是"宁可多算一个、也不要漏"：
     *   · 容器在、里面**一个 video 都没有** → 记成 `{video:null}` 的未完成任务点。
     *     绝不能丢：丢了就等于给"还没挂上来的那个"放行（v1.5.5 那个坑）。
     *   · 容器没覆盖到的播放器（超星换结构 / 视频挂在容器外）→ 照样收上来，
     *     `finished` 记为 null。绝不能丢：丢了就是"提前放行"。
     *   · 一个容器都认不出来 → 全部按 `finished:null` 处理，行为等于 v1.5.9。
     */
    activeTabVideoTasks() {
      const vids = this.activeTabVideos();   // 旧路径一行没改，它负责"哪些算任务点播放器"
      const boxes = this.videoTaskBoxes();
      if (!boxes.length) {
        return vids.map((v) => ({ video: v, container: null, finished: null }));
      }

      const tasks = [];
      const claimed = new Set();
      for (const b of boxes) {
        const inside = this.videosInBox(b.box);
        const mine = inside.filter((v) => vids.indexOf(v) >= 0);
        for (const v of mine) {
          claimed.add(v);
          tasks.push({ video: v, container: b.box, finished: b.finished });
        }
        if (!mine.length && !inside.length) {
          // 容器在、里面一个 video 都还没有 → 播放器正在创建，算"没到完成线"
          tasks.push({ video: null, container: b.box, finished: false });
        }
      }
      for (const v of vids) {
        if (!claimed.has(v)) tasks.push({ video: v, container: null, finished: null });
      }
      return tasks;
    },

    /**
     * 当前标签下的**视频任务点容器**（div.ans-attach-ct），DOM 序。
     *
     * 只认"看起来是视频任务点"的那些 —— 见 isVideoTaskBox()。
     */
    videoTaskBoxes() {
      const out = [];
      const walk = (w) => {
        let d;
        try { d = w.document; } catch (e) { return; }   // 跨域
        if (!d) return;

        let boxes = [];
        try { boxes = Array.from(d.querySelectorAll('div.ans-attach-ct')); } catch (e) { boxes = []; }
        for (const box of boxes) {
          if (!this.isVideoTaskBox(box)) continue;
          try {
            out.push({ box: box, finished: !!box.classList.contains('ans-job-finished') });
          } catch (e) { /* classList 读不到 → 当作认不出这个容器，跳过 */ }
        }

        let fs = [];
        try { fs = Array.from(d.querySelectorAll('iframe')); } catch (e) { return; }
        for (const f of fs) {
          try { if (f.contentWindow && f.contentWindow.document) walk(f.contentWindow); } catch (e) { /* 跨域子 frame，跳过 */ }
        }
      };
      walk((document && document.defaultView) || window);
      return out;
    },

    /**
     * 这个 div.ans-attach-ct 是不是**视频**任务点。
     *
     * 判据故意收窄：文档 / 图书类任务点也用 ans-attach-ct，认错了就会造出一个
     * "永远等不到播放器"的未完成任务点 → 那个标签再也不会被切走（卡死）。
     * 认不出来最多退回旧行为（位置判据），比卡死好。
     *
     * 四个判据任意一个成立即认：容器里有 video / 容器的类名带 videoContainer /
     * 容器里有超星的视频图标或插入视频占位 / 容器里的 iframe 指向视频模块。
     * （真机 6.1 实测这四个**都**成立。）
     */
    isVideoTaskBox(box) {
      if (!box) return false;
      try {
        if (box.querySelector('video')) return true;
        if (/\bvideoContainer\b/.test(String(box.className || ''))) return true;
        if (box.querySelector('.ans-job-video, .ans-insertvideo-online')) return true;
        const f = box.querySelector('iframe');
        if (f && /\/modules\/video\//i.test(String(f.getAttribute('src') || ''))) return true;
      } catch (e) { return false; }
      return false;
    },

    /**
     * 容器内部（含它自己 iframe 里）的**全部** video 元素，**不做任何过滤**。
     *
     * 过滤统一交给 activeTabVideos() —— 它那儿已经有一份判据（时长 ≤ 5 秒的小播放器、
     * 尺寸为 0 的隐藏播放器）。两处各写一份迟早会不一致，所以这里只负责"收上来"，
     * 再和 activeTabVideos() 的结果取交集。
     */
    videosInBox(box) {
      const out = [];
      const dig = (root) => {
        let vs = [];
        try { vs = Array.from(root.querySelectorAll('video')); } catch (e) { vs = []; }
        for (const v of vs) out.push(v);

        let fs = [];
        try { fs = Array.from(root.querySelectorAll('iframe')); } catch (e) { fs = []; }
        for (const f of fs) {
          let dd = null;
          try { dd = f.contentWindow && f.contentWindow.document; } catch (e) { dd = null; }
          if (dd) dig(dd);
        }
      };
      dig(box);
      return out;
    },

    /* ------------------------------------------------------------
     * ★ 顺序播放：一个「视频」标签下挂着多个视频任务点
     *
     * 真机 6.1「坚持以经济安全为基础的科学内涵」（2026-09-23 实测）：
     * 3 个任务点（两个视频 + 一个章节测验）在页面上只有 2 个标签 ——
     * 两个视频同属 dct1「视频」，各自一个 div.ans-attach-ct.videoContainer
     * + iframe + <video>（实测 845×712 / 845×541，**都可见**）。
     *
     * 为什么"逐个过完成线"（v1.5.9）还不够：
     *   它只保证**不提前切走**，但不负责把没播完的那个推起来。而每个 video
     *   在自己的 iframe 里各有一个 VideoModule 实例，各自只认自己那一个 ——
     *   谁都不知道"现在轮到谁了"。真机上的表现是：一个在播、一个停着，
     *   脚本一动不动地等，那个停着的永远到不了完成线。
     *
     * 所以需要**一个能同时看见全部视频的人**来决定次序，那就是顶层
     * （同源时顶层能钻遍所有 iframe）。判断依据只有一条：按 DOM 序找
     * **第一个还没到完成线的**，让它播，其余先等着。
     *
     * 为什么按 DOM 序：视频容器的排列顺序就是页面上从上到下的顺序，
     * 也就是超星列任务点的顺序 —— 这是唯一不需要额外信息就能确定的次序。
     *
     * 为什么不在 contentReachedDone() 里做：那个方法只在"当前标签该不该切"
     * 的时候被调用，而最后一个标签、或者「自动下一节」关掉时它根本不会被调到，
     * 视频就没人推了。编排必须在 check() 里无条件跑，见那里的说明。
     * ------------------------------------------------------------ */

    /**
     * 编排当前标签下所有视频的播放次序。幂等，可以每轮都调。
     *
     * @returns {number} 选中的下标；没有可编排的（非视频标签 / 视频少于 2 个）返回 -1
     */
    sequenceVideos() {
      if (!CONFIG.videoEnabled) return -1;    // 用户关掉了视频自动化 → 不碰播放器

      const tab = this.activeTab();
      if (!this.isVideoTab(tab)) return -1;   // 非视频标签：各自模块负责，不编排

      const tasks = this.activeTabVideoTasks();
      /*
       * 只有"有播放器"的任务点参与次序 —— 容器挂上了、播放器还没建出来的那种
       * 没法 play，让它占着 k 会把别的视频一直按在"等着"。
       *
       * 但它**照样算未完成**（contentReachedDone 走的是完整的 tasks），
       * 所以"谁播"和"能不能切走"不会因为这一步而放松。
       */
      const playable = tasks.filter((t) => !!t.video);
      const vs = playable.map((t) => t.video);
      if (vs.length <= 1) {
        /*
         * 0 个 / 1 个视频：没有"次序"可言。
         * 清掉缓存，让"切到这个标签"这件事被重新识别一次 —— 否则从多视频标签
         * 切到单视频标签时，缓存还留着上一个标签的形状，可能把不该动的视频动了。
         */
        this.seqVideos = null;
        this.seqActiveIdx = -1;
        return -1;
      }

      let k = -1;
      for (let i = 0; i < playable.length; i++) {
        if (!this.videoTaskDone(playable[i])) { k = i; break; }
      }

      /*
       * 编排结果没变 → 不重复下指令（不重复打日志、不重复 play/pause）。
       *
       * ⚠️ 但**标记必须续期**，不能在这里直接 return 走人 —— 见 refreshSeqStamps()。
       * 这是负向对照逼出来的一个真 bug：编排结果可能**长时间不变**
       * （一个 1387 秒的视频在 2 倍速下要播 11 分钟，这 11 分钟里 k 一直是 0），
       * 而标记有 15 秒保质期 —— 不续期的话，15 秒后"等着"的视频就会恢复自主播放，
       * 顺序播放当场失效，而且日志里一个字都看不出来。
       */
      if (this.seqVideos && this.seqVideos.length === vs.length &&
          this.seqActiveIdx === k &&
          this.seqVideos.every((x, i) => x === vs[i])) {
        this.refreshSeqStamps(vs);
        return k;
      }
      this.seqVideos = vs.slice();
      this.seqActiveIdx = k;

      if (k < 0) {
        log(`本标签下 ${vs.length} 个视频任务点都已到完成线 ✓`);
      } else {
        log(`顺序播放：本标签下 ${vs.length} 个视频任务点，` +
            `第 ${k + 1} 个还没到完成线 → 让它播，其余先等着`);
      }

      for (let i = 0; i < vs.length; i++) {
        this.applySeqState(vs[i], {
          /*
           * ★ 全部到线时 k = -1 → 一律 active=false。
           *
           * "现在谁都不该播"才是正确的语义。早先这里写成 k<0 时一律 active=true
           * （想的是"放开，别把谁按在等着"），结果是：被编排暂停过的那些视频
           * 被 VideoModule 的 watchdog 重新推起来播 —— 都已经过完成线了，
           * 再播一遍纯属浪费，还会和"顶层正在切标签"抢播放器。
           *
           * 这一条是**真实浏览器验证**抓出来的（bench/browser-verify-seq.html），
           * Node 切片测试看不见它：那里没有 watchdog，也没有真的 play()。
           *
           * 也不必担心"被永久按住"——标记有 15 秒保质期，顶层不在了就自动失效；
           * 而顶层还在时，它本来就在每 3 秒续期，说明它确实希望这些视频别播。
           */
          active: i === k,
          isLast: i === vs.length - 1,
          index: i,
          total: vs.length,
        });
      }
      return k;
    },

    /**
     * 把一个"现在该不该播"的决定落到某个 video 上，并立刻生效。
     *
     * 决定写的是 **video 元素**上的 `__cxSeq`，不是模块字段 —— 因为一个 frame 里
     * 可能不止一个 video，而那个 frame 的 VideoModule 只认自己 bind() 到的那一个。
     * 挂在元素上，谁读都能读到"这个视频现在该不该播"。
     *
     * 写完之后**顶层自己也直接操作一次元素**，不干等子 frame 反应：
     *   · 该播的 `play()`、该停的 `pause()` —— 同源时顶层本来就能直接控制，
     *     少一次往返，也兜住了"那个 frame 里脚本没跑起来"的情况；
     *   · 该停的为什么敢直接 pause：子 frame 的 pause 监听会先读 `__cxSeq`，
     *     看到 `active=false` 就不恢复了（见 VideoModule.attachEvents）。
     *     两边读的是同一份标记，所以不会出现"你暂停我恢复"的拉锯。
     *
     * @param {HTMLVideoElement} v
     * @param {{active:boolean,isLast:boolean,index:number,total:number}} st
     * @returns {boolean} 标记是否写上了（写不上只是退化成"没有编排"，不致命）
     */
    applySeqState(v, st) {
      if (!v) return false;

      let stamped = false;
      try {
        v.__cxSeq = {
          active: !!st.active,
          isLast: !!st.isLast,
          index: st.index,
          total: st.total,
          at: Date.now(),   // 新鲜度，见 VideoModule.SEQ_TTL_MS
        };
        stamped = true;
      } catch (e) {
        /* 元素上挂不了属性（少见）→ 下面照样直接操作元素，只是子 frame 不知道 */
      }

      try {
        if (st.active) {
          if (v.paused && !v.ended) {
            const p = v.play();
            if (p && p.catch) p.catch(() => {});
          }
        } else if (!v.paused) {
          v.pause();
        }
      } catch (e) {
        /* 播放器可能用自定义控件接管了，操作失败不影响标记本身 */
      }
      return stamped;
    },

    /**
     * 给已经写上去的编排标记续期（只改时间戳）。
     *
     * ★ 这一步**不能省**，也不能并进"结果变了才做"那个分支里 ——
     * 它是这套机制里唯一的心跳，而心跳断了不会报错，只会静默失效：
     *
     *   标记带保质期（VideoModule.SEQ_TTL_MS = 15 秒）是为了兜住"顶层不在了"
     *   （脚本被关、顶层 frame 崩了、页面被换成别的课）。但编排结果**可能长时间不变** ——
     *   真机 6.1 那个视频时长 1387 秒，2 倍速下要播 11 分钟，这 11 分钟里 k 一直是 0，
     *   一次都不会"变化"，于是也不会重新下达。
     *
     *   不续期的话，15 秒后标记过期 → "等着"的那些视频被 VideoModule 当成
     *   "没有编排、我该自己播" → watchdog 每 8 秒一次的"暂停就恢复"把它们全推起来。
     *   **顺序播放当场失效，而且日志里一个字都看不出来。**
     *
     * 续期只写时间戳：不碰播放状态、不打日志。所以它和"结果没变就不重复下指令"
     * 并不矛盾 —— 那个判断省的是 play/pause 与日志，不是心跳。
     */
    refreshSeqStamps(vs) {
      const now = Date.now();
      for (const v of vs) {
        try {
          const s = v && v.__cxSeq;
          if (s && isFinite(s.at)) s.at = now;
        } catch (e) { /* 元素上读不到标记就跳过 */ }
      }
    },

    /**
     * 记一条"为什么不推进"的日志，**同一个原因只打一次**。
     *
     * check() 每 3 秒跑一遍，视频加载那几秒会连着进来好几次 ——
     * 不节流的话日志会被同一句话刷满，反而看不见真正发生的变化。
     */
    noteHold(key, msg) {
      if (this.holdKey === key) return;
      this.holdKey = key;
      log(msg);
    },

    /** 当前激活的任务点标签；认不出返回 null */
    activeTab() {
      const tabs = this.taskTabs();
      const i = this.activeTaskIndex(tabs);
      return i >= 0 ? tabs[i] : null;
    },

    /**
     * 当前激活标签对应的那个内容 frame（视频播放器 / 测验页所在的那一层）。
     *
     * 顶层看不到播放器：真正的 video 在
     *   top → iframe(/mooc-ans/knowledge/cards) → iframe(/ananas/modules/video/index.html)
     * 里，所以要往下钻。同源才能钻，跨域的那一支直接跳过。
     */
    activeContentWindow() {
      let found = null;
      const walk = (w) => {
        if (found) return;
        let d;
        try { d = w.document; } catch (e) { return; }   // 跨域
        if (!d) return;
        try {
          if (d.querySelector('video') || d.querySelector('.TiMu, .questionLi, .queBox')) {
            found = w;
            return;
          }
        } catch (e) { /* 忽略，继续往下找 */ }
        let fs = [];
        try { fs = Array.from(d.querySelectorAll('iframe')); } catch (e) { return; }
        for (const f of fs) {
          try {
            if (f.contentWindow && f.contentWindow.document) walk(f.contentWindow);
          } catch (e) { /* 跨域子 frame，跳过 */ }
        }
      };
      walk((document && document.defaultView) || window);
      return found;
    },

    /** 当前章节还有几个未完成任务点（读目录项里的隐藏 input）；读不到返回 null */
    unfinishCount(item) {
      const n = item || this.currentCatalogItem();
      if (!n) return null;
      try {
        const inp = n.querySelector('input.jobUnfinishCount');
        if (!inp) return null;                       // 已完成的章节没有这个元素
        const v = parseInt(inp.value, 10);
        return isNaN(v) ? null : v;
      } catch (e) { return null; }
    },

    /** 页面上这一章的任务点标签（#prev_tab 里的 li，顺序即超星的任务点顺序） */
    taskTabs() {
      try { return Array.from(document.querySelectorAll('#prev_tab li')); }
      catch (e) { return []; }
    },

    /** 当前激活的任务点标签下标；没有返回 -1 */
    activeTaskIndex(tabs) {
      const list = tabs || this.taskTabs();
      for (let i = 0; i < list.length; i++) {
        if (/active|current/.test(list[i].className || '')) return i;
      }
      return -1;
    },

    /**
     * 任务点标签的完整名字。
     *
     * 真机上 li 带 title 属性，就是超星给的中文名（"视频" / "章节测验" / …），
     * 所以它既是给人看的名字，也是**判断任务点类型**的依据 —— 见 isVideoTab。
     * title 缺失时回落到标签文字（形如 "1视频"）。
     */
    tabName(tab) {
      if (!tab) return '';
      let t = '';
      try { t = tab.getAttribute('title') || ''; } catch (e) { /* 忽略 */ }
      if (!t) {
        try { t = tab.textContent || ''; } catch (e) { t = ''; }
      }
      return String(t).replace(/\s+/g, ' ').trim();
    },

    /**
     * 这个任务点标签是不是视频类。
     *
     * 用**名字**判断，而不是"内容里有没有 video" —— 后者分不清
     * "本来就不是视频"和"是视频但播放器还没挂上"，而那正是 v1.5.5
     * 把视频标签误切走的原因。
     */
    isVideoTab(tab) {
      return /视频/.test(this.tabName(tab));
    },

    /** 任务点标签的短名字（日志 / 诊断用） */
    tabLabel(tab) {
      if (!tab) return '(空)';
      return this.tabName(tab).slice(0, 20) || '(未命名)';
    },

    /** 是否处在跳转冷却期内 */
    cooldown() {
      return Date.now() - this.lastJumpAt < this.JUMP_COOLDOWN;
    },

    /**
     * 把目录状态广播给子 frame。
     *
     * 状态没变也每分钟重发一次：子 frame 侧（WorkModule.chapterDoneByCatalog）带
     * 5 分钟新鲜度限制，用来兜住"顶层被关掉/切走了"的情况。原来只在变化时写，
     * 于是一个完成状态挂了 5 分钟就自动过期，答题模块又对着做完的任务点答一遍。
     * 一分钟一次既能保鲜，也远低于当初担心的"每 5 秒刷一次存储"的开销。
     */
    broadcastChapterDone(done) {
      const now = Date.now();
      if (done === this.lastDone && now - this.lastDoneAt < this.HEARTBEAT_MS) return;
      this.lastDone = done;
      this.lastDoneAt = now;
      try { GM_setValue(EVT_CHAPTER_DONE, { at: now, done }); } catch (e) { return; }
      log(`目录状态：当前章节${done ? '已完成（答题模块会暂停）' : '未完成'}`);
    },

    /** 目录里的所有章节项（原始顺序，含互相嵌套的内外层） */
    catalogItems() {
      try { return Array.from(document.querySelectorAll(CATALOG_SELECTORS.join(','))); }
      catch (e) { return []; }
    },

    /** 目录里当前高亮的那一项；找不到返回 null */
    currentCatalogItem() {
      for (const n of this.catalogItems()) {
        if (/active|current/.test(n.className || '')) return n;
      }
      return null;
    },

    /**
     * 模拟点击「下一节」。
     *
     * 两条策略，按可靠性排序：
     *   1. 目录里当前章节的下一项 —— 宿主页面真正的导航入口，首选。
     *   2. 页面上的「下一节」按钮 —— 目录里找不到下一项时的兜底。
     *
     * ⚠️ 走策略 1 时，点的**不是**目录项容器，而是它内部真正挂了处理器的那个元素，
     * 见 clickTargetOf()。这一步写错就是"日志说切换了、页面纹丝不动"，而且不报错。
     *
     * @returns {boolean} 是否真的点到了
     */
    goNext() {
      // 先记时间：即使这一次没点成，也要走冷却，避免每 3 秒对着同一个元素猛点
      this.lastJumpAt = Date.now();

      const items = this.catalogItems();
      const curIdx = this.activeCatalogIndex(items);
      if (curIdx >= 0) {
        const next = this.nextCatalogItem(items, curIdx);
        if (next) {
          log('切换到下一节:', (next.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30));
          this.click(this.clickTargetOf(next));
          return true;
        }
      }

      const btn = findNextButton(document);
      if (btn) {
        log('点击「下一节」按钮:', (btn.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 30));
        this.click(btn);
        return true;
      }

      warn('未能自动切换下一节（目录里找不到当前章节，页面上也没有「下一节」按钮），请手动点击');
      return false;
    },

    /**
     * 目录项里**真正能触发跳转**的那个元素。
     *
     * 超星把导航处理器挂在**子元素**上：
     *     <div class="posCatalog_select">                     ← onclick = null
     *       <span class="posCatalog_name"
     *             onclick="getTeacherAjax(courseId, clazzid, chapterId, …)">…</span>
     *     </div>
     *
     * 点容器等于什么都没点：click 事件从容器**向上**冒泡，而 span 是它的**子节点**，
     * 根本不在冒泡路径上 —— 那个 onclick 永远不会执行。
     *
     * 真机实测（81 个目录项，把 getTeacherAjax 换成探针以免真的导航）：
     *     div.posCatalog_select.click()  → 处理器调用 **0** 次，页面纹丝不动
     *     span.posCatalog_name.click()   → 正常触发 getTeacherAjax(…, '1250628984')
     * 而 goNext() 拿到"点过了"照样返回 true —— 于是既不告警也不重试，静默失效。
     * 这正是"日志说已切换、页面不动"的根因。
     *
     * 所以逐层往下找带 onclick / href 的元素，而不是闭着眼点容器。
     */
    clickTargetOf(item) {
      if (!item) return null;
      // 1) 自己就能点（<a href> / 有 onclick）—— 最省事
      try {
        if (item.tagName === 'A' || item.onclick || item.getAttribute('href')) return item;
      } catch (e) { /* 属性读不到就继续往下找 */ }

      /*
       * 2) 往下找第一个**真的带处理器**的后代。
       *   `.posCatalog_name` —— 超星当前的写法（它的 onclick 就是 getTeacherAjax）
       *   `[onclick], a[href]` —— 不依赖类名的通用兜底，超星改版换类名时靠它
       * 顺序是先具体、后通用。
       */
      for (const sel of ['.posCatalog_name', '[onclick], a[href]']) {
        let list = [];
        try { list = Array.from(item.querySelectorAll(sel)); } catch (e) { list = []; }
        for (const n of list) {
          if (this.isClickable(n)) return n;
        }
      }

      /*
       * 3) 什么都没找到 → 退回容器本身。
       * 不会更糟，但 click() 会把它标成「⚠无 onclick/href」，日志里一眼能看出
       * "这一步没找到真正的入口"。
       */
      return item;
    },

    /**
     * 这个元素自身有没有可执行的行为。
     *
     * 判据是"onclick 是函数"或"href 非空"，**不是**"有没有 onclick 属性"。
     * 差别很关键：真机目录项里 EM / INPUT / SPAN 都带着 **空的** `onclick=""`
     * （实测），这种空壳用 `[onclick]` 属性选择器照样命中，但 `el.onclick` 是 null ——
     * 点它等于点了个寂寞。只有 `.posCatalog_name` 上那个是真的处理器。
     */
    isClickable(el) {
      if (!el) return false;
      try {
        if (typeof el.onclick === 'function') return true;
        if (el.getAttribute && el.getAttribute('href')) return true;
      } catch (e) { /* 忽略 */ }
      return false;
    },

    /**
     * 点一个元素 —— 原生 click 才会走宿主自己的跳转逻辑。
     *
     * 必须把"点了什么"记下来。这次的 bug 之所以能藏这么久，就是因为日志只写
     * 「切换到下一节: 4.2 …」，没写点的是哪个元素 —— 于是"点了但页面没动"
     * 和"点成功了"在日志里长得一模一样。现在带上标签、类名，以及**有没有可执行的
     * 处理器**，一眼就能分辨。
     */
    click(el) {
      if (!el) return;
      const desc = this.describeEl(el);
      try {
        if (typeof el.click === 'function') {
          el.click();
          log(`已点击 ${desc}`);
          return;
        }
        ['mousedown', 'mouseup', 'click'].forEach((t) => fireMouse(el, t));
        log(`已派发鼠标事件 ${desc}`);
      } catch (e) {
        warn('点击「下一节」失败:', (e && e.message) || e);
      }
    },

    /** 描述一个元素：标签 + 类名 + 是否带 onclick/href（诊断用） */
    describeEl(el) {
      if (!el) return '(空)';
      const cls = String(el.className || '').replace(/\s+/g, ' ').trim().slice(0, 40);
      const has = [];
      try {
        if (el.onclick) has.push('onclick');
        const href = el.getAttribute && el.getAttribute('href');
        if (href) has.push('href=' + String(href).slice(0, 24));
      } catch (e) { /* 忽略 */ }
      return `<${String(el.tagName || '?').toLowerCase()}${cls ? ` class="${cls}"` : ''}>` +
             (has.length ? ` [${has.join(' ')}]` : ' ⚠无 onclick/href');
    },

    /** 目录里高亮项的下标；没有返回 -1。多个命中时取最后一个（最内层那个才是真正被选中的） */
    activeCatalogIndex(items) {
      let idx = -1;
      for (let i = 0; i < items.length; i++) {
        if (/active|current/.test(items[i].className || '')) idx = i;
      }
      return idx;
    },

    /**
     * 这一项在目录里是不是**能点进去的导航项**。
     *
     * 超星的目录有两种行（真机实测：81 项 = 12 个章级 + 69 个节级）：
     *
     *   节级行  <div class="posCatalog_select">
     *             └ <span class="posCatalog_name" onclick="getTeacherAjax(…, chapterId)">
     *           处理器挂在 span 上，点它 = 跳转。69 项全是这个形状。
     *
     *   章级行  <div class="posCatalog_select firstLayer">
     *             └ <span class="posCatalog_title posCatalog_rotate titleIcon">
     *           类名里的 rotate / titleIcon 说明它是**展开、折叠**的开关。
     *           12 个章级项**全部**没有 `.posCatalog_name`，自身和祖先也都没有 onclick ——
     *           点它不跳转，只会把这一章收起来。
     *
     * 所以 nextCatalogItem 必须跳过章级行。v1.5.1 的真机日志里
     * `已点击 <div class="posCatalog_select firstLayer"> ⚠无 onclick/href`
     * 就是踩在这里：把章级行当成了"下一节"，点了个不会导航的开关。
     *
     * 判据为什么是"有没有 .posCatalog_name"，而不是"类名里有没有 firstLayer"：
     * `firstLayer` 是超星的内部命名，改版就会变；`.posCatalog_name` 是它自己挂
     * 导航处理器的地方，离"这一行能不能点"这个事实更近。
     *
     * 也刻意**不**去查"这个 name 属不属于这一行"（比如 closest('.posCatalog_select')）——
     * 那会再引入一个行类名的依赖：CATALOG_SELECTORS 里同时列着 `.chapter_item` /
     * `.posCatalog_level a`，万一超星换了版式，多这一层判断会让**所有**行都变成
     * "不可导航"，于是整条目录都被跳过 —— 比漏判危险得多。真机上章级行的子树里
     * 本来就没有 `.posCatalog_name`，这一条判据足够。
     */
    isNavigable(item) {
      if (!item) return false;
      // 自己就是链接 / 带处理器（别的 LMS，或超星改版）
      try {
        if (item.tagName === 'A' || typeof item.onclick === 'function') return true;
        if (item.getAttribute('href')) return true;
      } catch (e) { /* 属性读不到就继续往下找 */ }
      // 超星节级行：导航处理器挂在 .posCatalog_name 上；章级行没有它
      try { if (item.querySelector('.posCatalog_name')) return true; } catch (e) { /* 忽略 */ }
      // 退一步：子树里有没有真的带处理器的元素
      try {
        for (const n of item.querySelectorAll('[onclick], a[href]')) {
          if (this.isClickable(n)) return true;
        }
      } catch (e) { /* 忽略 */ }
      return false;
    },

    /**
     * 取"当前项之后的下一个**能点进去的**目录项"。
     *
     * 要跳过两类东西：
     *
     *   1. **与当前项互相嵌套的元素。** 目录选择器同时匹配 `li` 和它内部的 `a`
     *      （`.catalog_points_ul li` 与 `.posCatalog_level a`），两者都会进 items，
     *      而文档序里 `li` 紧挨着它的子 `a`。直接取 items[curIdx + 1] 很可能拿到
     *      **当前章节自己的子元素** —— 点它等于原地重载当前章节，页面纹丝不动，
     *      函数却照样返回 true，于是"没跳成"被记成"跳成了"，再也不会重试。
     *
     *   2. **章级行（展开/折叠开关）。** 见 isNavigable()。当前小节是本章最后一节时，
     *      下一个目录项就是下一章的章级行 —— 点它只会把下一章收起来，不会跳转。
     *      跳过它，落到它下面第一个真正的小节上。
     *      真机实测：12 个章级行后面**都**紧跟至少一个小节，所以跳过不会漏掉任务点。
     */
    nextCatalogItem(items, curIdx) {
      const cur = items[curIdx];
      for (let i = curIdx + 1; i < items.length; i++) {
        const n = items[i];
        if (cur.contains(n) || n.contains(cur)) continue;
        if (!this.isNavigable(n)) continue;
        return n;
      }
      return null;
    },
  };

  /* ============================================================
   * 9. 启动
   * ============================================================ */

  let CURRENT_ROLE = 'unknown';

  async function main() {
    const role = detectRole();
    CURRENT_ROLE = role;
    log(`frame 角色: ${role} | ${location.href.slice(0, 90)}`);

    /*
     * 在自己的文档上打标记，声明"这一层已经有脚本了"。
     *
     * questionRoot() 靠它避免让外层壳替内层测验页干活（同源嵌套时两者都能看到
     * 同一批题，两边都处理会导致重复点击、多选被点掉）。所以这个标记必须在
     * 任何 questionRoot() 调用之前打上。
     */
    try { document.documentElement.setAttribute(FRAME_MARK, role); } catch (e) { /* 忽略 */ }

    /*
     * 只有真正要干活的 frame 才注册配置监听。
     * 超星课程页有十几个 frame，无关的小 iframe 各挂一个监听器纯属浪费
     * （每次配置写入都要在所有 frame 里跑一遍回调）。
     */
    if (role !== 'unknown') registerConfigListener();

    /*
     * 顶层无条件挂面板 —— 即使顶层的角色不是 'top'。
     *
     * 章节测验有可能是新标签页打开的，那时顶层自己就是题目页（role = 'work'）。
     * 老代码只在 role === 'top' 时挂面板，于是那种情况下页面上**什么都不会出现**：
     * 没有面板、没有日志、没有任何反馈，用户只能得到"脚本没反应"的结论。
     * 面板本身就是脚本的可观测界面，顶层有它是底线。
     */
    if (isTop) Panel.mount();

    switch (role) {
      case 'video':
        VideoModule.start();
        break;
      case 'work':
        // 作业页可能是懒加载的，隔一会儿再抓
        await sleep(1500);
        WorkModule.start();
        break;
      case 'doc':
        DocModule.start();
        break;
      case 'top':
        NextModule.start();
        break;
      default:
        /*
         * 未知 frame。
         *
         * 超星课程页有十几个小 iframe，大部分跟答题无关，但它们的 URL 五花八门，
         * 谁也不能保证哪个里面不会冒出题目来。所以这里也挂上观察 ——
         * 代价极低（只有开了答题才会真的轮询，而且会退避到 8 秒一次），
         * 但能兜住"角色没认出来 → 脚本完全不动"这一类问题。
         * 注意这里调的是 watch() 而不是 start()，不写启动日志，免得刷屏。
         */
        if (document.querySelector('video')) VideoModule.start();
        else if (CONFIG.answerEnabled) WorkModule.watch();
    }

    /*
     * 「重新执行」的接收端：**所有** frame 都注册。
     *
     * 这里跟配置监听不一样 —— 配置监听是每次保存都会广播给所有 frame，
     * 所以必须按角色裁剪；而「重新执行」是用户手动点的低频动作，
     * 漏掉任何一个 frame 的代价（点了没反应）远大于那点开销。
     */
    registerRetryListener();
    // 状态上报：诊断面板靠它看到子 frame 里到底发生了什么
    registerReportListener();
    // 等模块都起来了再上报，否则报的是"还没启动"的状态，没有参考价值
    Timers.after(reportSelf, 2500);

    onConfigChanged = () => {
      if (VideoModule.video) VideoModule.applySettings();
      if (isTop) Panel.setDot(CONFIG.videoEnabled || CONFIG.answerEnabled);
      // 答题开关从关变开时，让观察循环立刻起来（不用等页面刷新）
      if (CONFIG.answerEnabled && role === 'work' && !WorkModule.watching) WorkModule.restart();
      /*
       * 关掉「题旁显示进度」时要立刻清掉已插入的徽标。
       * 不清的话，页面上会残留一批写着"AI 作答中…"的牌子，
       * 而功能其实已经关了 —— 用户会以为脚本还在跑。
       */
      if (!CONFIG.showProgress) QProgress.clearAll();
    };
  }



  // 顶层加菜单命令，方便不开面板时快速开关
  try {
    GM_registerMenuCommand('▶ 开关自动答题', () => {
      saveConfig({ answerEnabled: !CONFIG.answerEnabled });
      log(`自动答题 → ${CONFIG.answerEnabled ? '开' : '关'}`);
    });
    GM_registerMenuCommand('🔄 恢复默认配置', () => {
      saveConfig(DEFAULT_CONFIG);
      log('已恢复默认配置');
    });
  } catch (e) {}

  main().catch((e) => warn('初始化失败:', e.message || e));
})();
