export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("Bot Service is Running", { status: 200 });
    }

    try {
      const update = await request.json();

      if (update.callback_query) {
        await handleCallbackQuery(env, update.callback_query);
        return new Response("OK", { status: 200 });
      }

      const message = update.message;
      if (message && message.text) {
        const chatId = message.chat.id;
        const text = message.text.trim();

        // 字符白名单拦截
        const illegalCharRegex = /[^\p{Script=Han}a-zA-Z0-9\s\p{P}]/gu;
        if (illegalCharRegex.test(text)) {
          await sendMessage(
            env.TELEGRAM_BOT_TOKEN,
            chatId,
            "[错误] 指令只支持中文、英文、数字和常用标点，不能包含表情或特殊符号！"
          );
          return new Response("OK", { status: 200 });
        }

        const Handled = await handleUserCommands(env, chatId, text);
        if (Handled) return new Response("OK", { status: 200 });

        if (text === "/start" || text === "/menu") {
          await sendGameMenu(env, chatId);
        } else if (text === "/stop") {
          await handleManualStop(env, chatId);
        } else if (/^\d{1,10}$/.test(text)) {
          const rawState = await env.GAME_KV.get(`game_${chatId}`);
          if (rawState) {
            await handleGameInput(env, chatId, text, JSON.parse(rawState));
          }
        }
      }
    } catch (err) {
      console.error(err);
    }

    return new Response("OK", { status: 200 });
  }
};

// ==================== 理论极限配置 ====================
const GUESS_WORST_CASE = { 1: 4, 2: 7, 3: 10, 4: 14, 5: 17, 6: 20, 7: 24, 8: 27, 9: 30, 10: 34 };
const BULLS_WORST_CASE = { 1: 10, 2: 6, 3: 7, 4: 7, 5: 8, 6: 8, 7: 9, 8: 9, 9: 10, 10: 10 };
const INVITE_EXPIRE_SECONDS = 3 * 24 * 60 * 60; // 3 天

const ROLE_LEVEL = {
  user: 0,
  sub_admin: 1,
  mid_admin: 2,
  super_admin: 3
};

async function isLockMechanismDisabled(env, user) {
  if (user && ROLE_LEVEL[user.role] >= ROLE_LEVEL.mid_admin) {
    return true;
  }
  const config = await getGlobalConfig(env);
  return config.disableLockMechanism === true;
}

// ==================== 用户与配置管理 ====================
async function getGlobalConfig(env) {
  const raw = await env.GAME_KV.get("config_global");
  if (!raw) {
    return { requireInvite: false, hasSuperAdmin: false, disableLockMechanism: false };
  }
  return JSON.parse(raw);
}

async function saveGlobalConfig(env, config) {
  await env.GAME_KV.put("config_global", JSON.stringify(config));
}

async function getUser(env, chatId) {
  const raw = await env.GAME_KV.get(`user_${chatId}`);
  if (!raw) return null;
  const user = JSON.parse(raw);

  if (!user.progress) {
    user.progress = {
      guess: { maxUnlockedLength: 1, maxUnlockedLevel: 1, timesPassed: 0 },
      bulls: { maxUnlockedLength: 1, maxUnlockedLevel: 1, timesPassed: 0 }
    };
  } else {
    if (user.progress.guess.timesPassed === undefined) user.progress.guess.timesPassed = 0;
    if (user.progress.bulls.timesPassed === undefined) user.progress.bulls.timesPassed = 0;
  }
  return user;
}

async function saveUser(env, chatId, user) {
  await env.GAME_KV.put(`user_${chatId}`, JSON.stringify(user));
}

async function handleUserCommands(env, chatId, text) {
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const currentUser = await getUser(env, chatId);

  if (currentUser && currentUser.isBanned) {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "[警告] 你的账号已被封禁，无法使用任何功能。");
    return true;
  }

  if (cmd === "/help") {
    await sendHelpMenu(env, chatId, currentUser);
    return true;
  }

  if (cmd === "/register") {
    if (currentUser && currentUser.isLoggedIn) {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `[提示] 你已经注册并处于登录状态。你的 ID: ${chatId}`);
      return true;
    }

    const config = await getGlobalConfig(env);
    const inviteInput = parts[1] ? parts[1].trim() : "";

    // 只有在开启邀请机制且存在超级管理员时校验邀请码
    if (config.requireInvite && config.hasSuperAdmin) {
      if (!inviteInput) {
        await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "[注册失败] 当前已开启邀请制，请输入邀请码注册！格式: /register <邀请码>");
        return true;
      }
      const inviteData = await env.GAME_KV.get(`invite_${inviteInput}`);
      if (!inviteData) {
        await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "[注册失败] 邀请码无效、不存在或已过期！");
        return true;
      }
      // 成功使用，核销删除邀请码
      await env.GAME_KV.delete(`invite_${inviteInput}`);
    }

    let role = "user";
    // 首个注册用户自动升为超级管理员
    if (!config.hasSuperAdmin) {
      role = "super_admin";
      config.hasSuperAdmin = true;
      await saveGlobalConfig(env, config);
    }

    const newUser = {
      chatId: chatId,
      role: role,
      score: 0,
      wins: 0,
      isLoggedIn: true,
      isBanned: false,
      progress: {
        guess: { maxUnlockedLength: 1, maxUnlockedLevel: 1, timesPassed: 0 },
        bulls: { maxUnlockedLength: 1, maxUnlockedLevel: 1, timesPassed: 0 }
      }
    };

    await saveUser(env, chatId, newUser);

    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId,
      `[注册成功]\n` +
      `你的 Telegram ID: ${chatId}\n` +
      `你的身份: ${getRoleName(role)}\n` +
      `初始积分: 0`
    );
    return true;
  }

  if (cmd === "/login") {
    if (!currentUser) {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "[登录失败] 账号不存在，请发送 /register 进行注册。");
      return true;
    }
    currentUser.isLoggedIn = true;
    await saveUser(env, chatId, currentUser);
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `[登录成功] 欢迎回来！你的 ID: ${chatId} | 身份: ${getRoleName(currentUser.role)}`);
    return true;
  }

  if (!currentUser || !currentUser.isLoggedIn) {
    if (cmd === "/start" || cmd === "/menu" || cmd === "/leaderboard") {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "[未登录] 请先发送 /register 注册或 /login 登录。");
      return true;
    }
    return false;
  }

  if (cmd === "/logout") {
    currentUser.isLoggedIn = false;
    await saveUser(env, chatId, currentUser);
    await env.GAME_KV.delete(`game_${chatId}`);
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "[已退出登录] 游戏状态已清理。");
    return true;
  }

  if (cmd === "/me") {
    const pG = currentUser.progress.guess;
    const pB = currentUser.progress.bulls;
    const isDisabled = await isLockMechanismDisabled(env, currentUser);

    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId,
      `[个人中心]\n` +
      `你的 Telegram ID: ${currentUser.chatId}\n` +
      `权限等级: ${getRoleName(currentUser.role)}\n` +
      `当前积分: ${currentUser.score} | 总胜场: ${currentUser.wins}\n\n` +
      `【关卡解锁进度】${isDisabled ? " (当前特权/全局限制已关)" : ""}\n` +
      `猜数字: 已解锁 ${pG.maxUnlockedLength}位数 难度${pG.maxUnlockedLevel} (进度: ${pG.timesPassed}/3)\n` +
      `猜密码: 已解锁 ${pB.maxUnlockedLength}位数 难度${pB.maxUnlockedLevel} (进度: ${pB.timesPassed}/3)`
    );
    return true;
  }

  if (cmd === "/leaderboard") {
    await sendLeaderboard(env, chatId);
    return true;
  }

  // ==================== 管理员专属指令 ====================

  if (cmd === "/gen_code") {
    if (ROLE_LEVEL[currentUser.role] < ROLE_LEVEL.sub_admin) {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "[越权操作] 生成邀请码属于管理员专属功能！");
      return true;
    }
    const newCode = "SYS_" + Math.random().toString(36).substring(2, 8).toUpperCase();
    const creatorInfo = `Creator:${chatId}|Time:${Date.now()}`;
    await env.GAME_KV.put(`invite_${newCode}`, creatorInfo, { expirationTtl: INVITE_EXPIRE_SECONDS });
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `[生成成功] 邀请码: ${newCode}\n(3天内有效，仅可使用一次)`);
    return true;
  }

  if (cmd === "/invite_list") {
    if (ROLE_LEVEL[currentUser.role] < ROLE_LEVEL.mid_admin) {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "[越权操作] 只有中管理及以上可以查看所有邀请码。");
      return true;
    }
    const list = await env.GAME_KV.list({ prefix: "invite_" });
    if (list.keys.length === 0) {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "[邀请码列表] 当前没有任何有效邀请码。");
      return true;
    }

    let resultText = "=== 现有有效邀请码列表 ===\n\n";
    for (const k of list.keys) {
      const code = k.name.replace("invite_", "");
      const info = await env.GAME_KV.get(k.name);
      resultText += `邀请码: ${code} | 信息: ${info}\n`;
    }
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, resultText);
    return true;
  }

  if (cmd === "/toggle_invite") {
    if (ROLE_LEVEL[currentUser.role] < ROLE_LEVEL.mid_admin) {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "[越权操作] 只有中管理及以上可以修改邀请限制。");
      return true;
    }
    const config = await getGlobalConfig(env);
    config.requireInvite = !config.requireInvite;
    await saveGlobalConfig(env, config);
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `[设置成功] 注册邀请码限制已【${config.requireInvite ? "开启" : "关闭"}】。`);
    return true;
  }

  if (cmd === "/toggle_unlock") {
    if (ROLE_LEVEL[currentUser.role] < ROLE_LEVEL.mid_admin) {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "[越权操作] 只有中管理及以上可以修改锁关开关！");
      return true;
    }
    const config = await getGlobalConfig(env);
    config.disableLockMechanism = !config.disableLockMechanism;
    await saveGlobalConfig(env, config);
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `[设置成功] 全局锁关机制已【${config.disableLockMechanism ? "关闭 (所有人全关卡解锁)" : "开启 (需通关3次解锁)"}】。`);
    return true;
  }

  if (cmd === "/setrole") {
    if (currentUser.role !== "super_admin") {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "[越权操作] 只有大管理员(超管)有权修改用户权限！");
      return true;
    }
    const targetChatId = parts[1];
    const targetRole = parts[2];
    if (!targetChatId || !targetRole || !ROLE_LEVEL.hasOwnProperty(targetRole)) {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "格式错误: /setrole <TargetChatID> <super_admin|mid_admin|sub_admin|user>");
      return true;
    }
    const targetUser = await getUser(env, targetChatId);
    if (!targetUser) {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "[失败] 未找到目标用户。");
      return true;
    }
    targetUser.role = targetRole;
    await saveUser(env, targetChatId, targetUser);
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `[成功] 已将用户 ${targetChatId} 权限修改为: ${getRoleName(targetRole)}`);
    return true;
  }

  if (cmd === "/ban") {
    if (currentUser.role !== "super_admin") {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "[越权操作] 只有大管理员(超管)有权封禁账号！");
      return true;
    }
    const targetChatId = parts[1];
    if (!targetChatId) {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "格式错误: /ban <TargetChatID>");
      return true;
    }
    const targetUser = await getUser(env, targetChatId);
    if (!targetUser) {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "[失败] 目标用户不存在。");
      return true;
    }
    targetUser.isBanned = true;
    targetUser.isLoggedIn = false;
    await saveUser(env, targetChatId, targetUser);
    await env.GAME_KV.delete(`game_${targetChatId}`);
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `[成功] 已封禁用户 ${targetChatId}！`);
    return true;
  }

  if (cmd === "/unban") {
    if (currentUser.role !== "super_admin") {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "[越权操作] 只有大管理员(超管)有权解封账号！");
      return true;
    }
    const targetChatId = parts[1];
    if (!targetChatId) {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "格式错误: /unban <TargetChatID>");
      return true;
    }
    const targetUser = await getUser(env, targetChatId);
    if (!targetUser) {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "[失败] 目标用户不存在。");
      return true;
    }
    targetUser.isBanned = false;
    await saveUser(env, targetChatId, targetUser);
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `[成功] 已解除用户 ${targetChatId} 的封禁！`);
    return true;
  }

  return false;
}

async function sendHelpMenu(env, chatId, user) {
  let helpText = "=== 游戏指令帮助菜单 ===\n\n";

  helpText += "【基础指令】\n";
  helpText += "/register <邀请码> - 注册账号 (若开启邀请制需填)\n";
  helpText += "/login - 登录账号\n";
  helpText += "/logout - 退出登录\n";
  helpText += "/menu - 打开游戏选关菜单\n";
  helpText += "/stop - 终止游戏 (扣除对应积分)\n";
  helpText += "/me - 查看个人信息及 ID\n";
  helpText += "/leaderboard - 查看积分排行榜\n\n";

  if (user && ROLE_LEVEL[user.role] >= ROLE_LEVEL.sub_admin) {
    helpText += "【小/中/大管理员指令】\n";
    helpText += "/gen_code - 生成一个3天有效的邀请码\n";
  }

  if (user && ROLE_LEVEL[user.role] >= ROLE_LEVEL.mid_admin) {
    helpText += "\n【中/大管理员管理指令】\n";
    helpText += "/invite_list - 查看当前可用邀请码\n";
    helpText += "/toggle_invite - 开启/关闭注册邀请制\n";
    helpText += "/toggle_unlock - 开启/关闭全局锁关限制\n";
  }

  if (user && user.role === "super_admin") {
    helpText += "\n【大管理员(超管)专属特权】\n";
    helpText += "/setrole <ID> <级别> - 修改用户角色\n";
    helpText += "/ban <ID> - 封禁用户\n";
    helpText += "/unban <ID> - 解封用户\n";
  }

  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, helpText);
}

function getRoleName(role) {
  const names = { super_admin: "大管理员(超管)", mid_admin: "中管理员", sub_admin: "小管理员", user: "普通玩家" };
  return names[role] || "未知";
}

async function sendLeaderboard(env, chatId) {
  const list = await env.GAME_KV.list({ prefix: "user_" });
  let users = [];

  for (const key of list.keys) {
    const raw = await env.GAME_KV.get(key.name);
    if (raw) users.push(JSON.parse(raw));
  }

  users.sort((a, b) => b.score - a.score);
  const top10 = users.slice(0, 10);

  let rankText = "=== 积分排行榜 TOP 10 ===\n\n";
  top10.forEach((u, index) => {
    rankText += `第 ${index + 1} 名 | 用户ID: ${u.chatId} | 积分: ${u.score} (胜场: ${u.wins})\n`;
  });

  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, rankText);
}

// ==================== 动态菜单渲染 ====================
function getMaxAttempts(mode, length, level) {
  const baseLimit = mode === "guess" ? GUESS_WORST_CASE[length] : BULLS_WORST_CASE[length];
  const multipliers = { 1: 1.8, 2: 1.5, 3: 1.3, 4: 1.1, 5: 1.0 };
  return Math.ceil(baseLimit * multipliers[level]);
}

function getMainMenuButtons() {
  return {
    inline_keyboard: [
      [
        { text: "猜数字 (1-5位)", callback_data: "select_len_guess_p1" },
        { text: "猜数字 (6-10位)", callback_data: "select_len_guess_p2" }
      ],
      [
        { text: "猜密码 (1-5位)", callback_data: "select_len_bulls_p1" },
        { text: "猜密码 (6-10位)", callback_data: "select_len_bulls_p2" }
      ]
    ]
  };
}

function getLengthButtons(mode, page, user, isDisabled) {
  const maxUnlocked = user.progress[mode].maxUnlockedLength;
  const start = page === 1 ? 1 : 6;
  const row = [];

  for (let i = start; i < start + 5; i++) {
    const isLocked = !isDisabled && (i > maxUnlocked);
    const btnText = isLocked ? `[锁关] ${i}位` : `${i}位数`;
    const callbackData = isLocked ? `locked_len_${i}` : `choose_len_${mode}_${i}`;
    row.push({ text: btnText, callback_data: callbackData });
  }

  const navRow = [];
  if (page === 1) {
    navRow.push({ text: "下一页 (6-10位) ->", callback_data: `select_len_${mode}_p2` });
  } else {
    navRow.push({ text: "<- 上一页 (1-5位)", callback_data: `select_len_${mode}_p1` });
  }

  return {
    inline_keyboard: [
      row,
      navRow,
      [{ text: "[返回主菜单]", callback_data: "main_menu" }]
    ]
  };
}

function getDifficultyButtons(mode, length, user, isDisabled) {
  const maxUnlockedLevel = user.progress[mode].maxUnlockedLevel;
  const currentLen = user.progress[mode].maxUnlockedLength;
  const timesPassed = user.progress[mode].timesPassed || 0;
  const rows = [];

  const createLevelBtn = (lvl) => {
    const isLocked = !isDisabled && (length > currentLen || (length === currentLen && lvl > maxUnlockedLevel));
    const attempts = getMaxAttempts(mode, length, lvl);
    
    if (isLocked) {
      return { text: `[锁关] 难度${lvl}`, callback_data: `locked_level_${lvl}` };
    }

    let extraLabel = "";
    if (!isDisabled && length === currentLen && lvl === maxUnlockedLevel && lvl <= 5) {
      extraLabel = ` (${timesPassed}/3)`;
    }

    return { text: `难度${lvl}${extraLabel} (${attempts}次)`, callback_data: `start_${mode}_${length}_${lvl}` };
  };

  rows.push([createLevelBtn(1), createLevelBtn(2), createLevelBtn(3)]);
  rows.push([createLevelBtn(4), createLevelBtn(5)]);
  rows.push([{ text: "[返回位数选择]", callback_data: `select_len_${mode}_${length <= 5 ? 'p1' : 'p2'}` }]);

  return { inline_keyboard: rows };
}

function getInGameButtons(length) {
  return {
    inline_keyboard: [
      [{ text: `请在对话框发送 ${length} 位数字`, callback_data: "input_hint" }],
      [{ text: "[终止当前游戏 (扣除积分)]", callback_data: "stop_game" }]
    ]
  };
}

async function sendGameMenu(env, chatId) {
  const user = await getUser(env, chatId);
  const isDisabled = await isLockMechanismDisabled(env, user);

  const text =
    `=== 欢迎来到猜数字/密码游戏 ===\n` +
    `你的 Telegram ID: ${chatId}\n\n` +
    `【积分结算规则】\n` +
    `* 胜利: 增加 (位数 * 难度 * 100) 积分\n` +
    `* 失败/中途停止: 扣除 (位数 * 难度 * 50) 积分\n\n` +
    `【锁关规则】\n` +
    `最高难度需【通关 3 次】解封下一关！\n` +
    (isDisabled ? "[提示] 锁关限制已解除。\n\n" : "[提示] 锁关限制生效中。\n\n") +
    "请选择挑战模式与位数:";

  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, text, getMainMenuButtons());
}

async function handleCallbackQuery(env, query) {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data;

  const user = await getUser(env, chatId);
  if (!user || !user.isLoggedIn) {
    await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, query.id, "请先发送 /login 登录");
    return;
  }

  if (user.isBanned) {
    await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, query.id, "你的账号已被封禁");
    return;
  }

  await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, query.id);

  if (data.startsWith("locked_len_")) {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "[未解锁] 请先将前一位数的【难度5】通关 3 次！");
    return;
  }
  if (data.startsWith("locked_level_")) {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "[未解锁] 请先将上一难度通关 3 次！");
    return;
  }

  const isDisabled = await isLockMechanismDisabled(env, user);

  if (data === "main_menu") {
    await sendGameMenu(env, chatId);
  }
  else if (data.startsWith("select_len_")) {
    const parts = data.split("_");
    const mode = parts[2];
    const page = parts[3] === "p1" ? 1 : 2;
    const modeName = mode === "guess" ? "猜数字 (大小比较)" : "猜密码 (位置判断)";
    await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId,
      `当前模式: ${modeName}\n\n` +
      `【解锁规则】每个难度需通关 3 次方可解锁下一关！\n` +
      `请选择位数 (${page === 1 ? '1-5位' : '6-10位'}):`,
      getLengthButtons(mode, page, user, isDisabled)
    );
  }
  else if (data.startsWith("choose_len_")) {
    const parts = data.split("_");
    const mode = parts[2];
    const length = parseInt(parts[3], 10);
    const modeName = mode === "guess" ? "猜数字" : "猜密码";
    const worst = mode === "guess" ? GUESS_WORST_CASE[length] : BULLS_WORST_CASE[length];

    await editMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId,
      `[ ${modeName} - ${length}位数 ]\n\n` +
      `[提示] 难度越高/位数越多，胜负加扣的积分越多！\n` +
      `理论极限情况: ${worst} 次尝试 (对应难度 5)。`,
      getDifficultyButtons(mode, length, user, isDisabled)
    );
  }
  else if (data.startsWith("start_")) {
    const parts = data.split("_");
    const mode = parts[1];
    const length = parseInt(parts[2], 10);
    const level = parseInt(parts[3], 10);

    if (mode === "guess") {
      await initGuessGame(env, chatId, length, level);
    } else {
      await initBullsGame(env, chatId, length, level);
    }
  }
  else if (data === "stop_game") {
    await handleManualStop(env, chatId);
  } else if (data === "input_hint") {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "提示: 直接在聊天框输入你的猜测数字并发送即可！");
  }
}

// ==================== 游戏业务、积分算法与解锁逻辑 ====================
async function initGuessGame(env, chatId, length, level) {
  const maxAttempts = getMaxAttempts("guess", length, level);
  let secret = "";
  for (let i = 0; i < length; i++) {
    secret += Math.floor(Math.random() * 10).toString();
  }

  const gameState = {
    type: "guess",
    length: length,
    secret: secret,
    attempts: 0,
    maxAttempts: maxAttempts,
    level: level,
    history: []
  };

  await env.GAME_KV.put(`game_${chatId}`, JSON.stringify(gameState), { expirationTtl: 1800 });
  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId,
    `[ 游戏开始: 猜数字 - ${length}位数 ]\n\n` +
    `* 难度: ${level} (最多尝试: ${maxAttempts} 次)\n` +
    `* 预期积分结算: 胜利 +${length * level * 100} / 失败 -${length * level * 50}\n\n` +
    `请输入你的 ${length} 位数字:`,
    getInGameButtons(length)
  );
}

async function initBullsGame(env, chatId, length, level) {
  const maxAttempts = getMaxAttempts("bulls", length, level);
  const digits = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"];
  let secret = "";
  for (let i = 0; i < length; i++) {
    const idx = Math.floor(Math.random() * digits.length);
    secret += digits[idx];
    digits.splice(idx, 1);
  }

  const gameState = {
    type: "bulls",
    length: length,
    secret: secret,
    attempts: 0,
    maxAttempts: maxAttempts,
    level: level,
    history: []
  };

  await env.GAME_KV.put(`game_${chatId}`, JSON.stringify(gameState), { expirationTtl: 1800 });
  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId,
    `[ 游戏开始: 猜密码 - ${length}位数 ]\n\n` +
    `* 难度: ${level} (最多尝试: ${maxAttempts} 次)\n` +
    `* 预期积分结算: 胜利 +${length * level * 100} / 失败 -${length * level * 50}\n\n` +
    `请输入你的 ${length} 位密码猜测:`,
    getInGameButtons(length)
  );
}

async function handleManualStop(env, chatId) {
  const rawState = await env.GAME_KV.get(`game_${chatId}`);
  if (!rawState) {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "[提示] 当前没有任何正在进行的游戏。");
    return;
  }
  const state = JSON.parse(rawState);
  const lostScore = await processLossScore(env, chatId, state.level, state.length);
  await env.GAME_KV.delete(`game_${chatId}`);
  
  await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, 
    `[终止] 游戏已手动取消！\n` +
    `扣除积分: -${lostScore}`,
    getMainMenuButtons()
  );
}

async function processWinUnlock(env, chatId, mode, level, length) {
  const user = await getUser(env, chatId);
  if (!user) return { gained: 0, unlockMsg: "" };

  const gained = length * level * 100;
  user.score += gained;
  user.wins += 1;

  const modeProgress = user.progress[mode];
  let unlockMsg = "";

  if (length === modeProgress.maxUnlockedLength && level === modeProgress.maxUnlockedLevel) {
    modeProgress.timesPassed = (modeProgress.timesPassed || 0) + 1;

    if (modeProgress.timesPassed >= 3) {
      modeProgress.timesPassed = 0;

      if (level < 5) {
        modeProgress.maxUnlockedLevel += 1;
        unlockMsg = `\n[解锁] 恭喜！你已累计通关 3 次！成功解锁【难度 ${modeProgress.maxUnlockedLevel}】！`;
      } else if (level === 5 && length < 10) {
        modeProgress.maxUnlockedLength += 1;
        modeProgress.maxUnlockedLevel = 1;
        unlockMsg = `\n[解锁] 完美通关难度5（3次）！成功晋级解锁【${modeProgress.maxUnlockedLength} 位数】难度 1！`;
      } else {
        unlockMsg = `\n[解锁] 你已登顶最高关卡并通关 3 次！`;
      }
    } else {
      unlockMsg = `\n当前关卡通关进度: [ ${modeProgress.timesPassed}/3 ] (还需通关 ${3 - modeProgress.timesPassed} 次解锁下一关)`;
    }
  }

  await saveUser(env, chatId, user);
  return { gained, unlockMsg };
}

async function processLossScore(env, chatId, level, length) {
  const user = await getUser(env, chatId);
  if (!user) return 0;

  const lost = length * level * 50;
  user.score = Math.max(0, user.score - lost);
  await saveUser(env, chatId, user);
  return lost;
}

async function handleGameInput(env, chatId, inputStr, state) {
  const length = state.length;

  if (inputStr.length !== length) {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `[警告] 输入长度必须为 ${length} 位数，你输入了 ${inputStr.length} 位。`);
    return;
  }

  if (state.type === "guess") {
    state.attempts += 1;
    const remaining = state.maxAttempts - state.attempts;

    const userNum = BigInt(inputStr);
    const secretNum = BigInt(state.secret);

    let resultText = "";
    if (userNum === secretNum) {
      const { gained, unlockMsg } = await processWinUnlock(env, chatId, "guess", state.level, state.length);
      await env.GAME_KV.delete(`game_${chatId}`);
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId,
        `[胜利] 恭喜你猜对了!\n正确数字是: ${state.secret}\n` +
        `奖励积分: +${gained}\n` +
        `【猜数字】${unlockMsg}`,
        getMainMenuButtons()
      );
      return;
    } else if (userNum > secretNum) {
      resultText = "猜大了";
    } else {
      resultText = "猜小了";
    }

    state.history.push(`${inputStr} -> ${resultText}`);

    if (state.attempts >= state.maxAttempts) {
      const lostScore = await processLossScore(env, chatId, state.level, state.length);
      await env.GAME_KV.delete(`game_${chatId}`);
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId,
        `[失败] 已达到最大尝试次数限制 (${state.maxAttempts} 次)。\n` +
        `扣除积分: -${lostScore}\n` +
        `正确答案是: ${state.secret}\n\n` +
        `历史记录:\n${state.history.join("\n")}`,
        getMainMenuButtons()
      );
      return;
    }

    await env.GAME_KV.put(`game_${chatId}`, JSON.stringify(state), { expirationTtl: 1800 });
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId,
      `反馈结果: 你输入的数字【${resultText}】 (剩余次数: ${remaining})\n\n` +
      `近期历史:\n${state.history.slice(-8).join("\n")}`,
      getInGameButtons(length)
    );
  }
  else if (state.type === "bulls") {
    if (new Set(inputStr).size !== length) {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `[警告] 密码各位数必须不重复。请输入 ${length} 个互不相同的数字。`);
      return;
    }

    const { feedback, isWin } = compareCodeNoDuplicates(inputStr, state.secret, length);
    state.attempts += 1;
    const remaining = state.maxAttempts - state.attempts;

    state.history.push(`${inputStr} -> ${feedback}`);

    if (isWin) {
      const { gained, unlockMsg } = await processWinUnlock(env, chatId, "bulls", state.level, state.length);
      await env.GAME_KV.delete(`game_${chatId}`);
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId,
        `[胜利] 密码破译成功!\n正确密码: ${state.secret}\n` +
        `奖励积分: +${gained}\n` +
        `【猜密码】${unlockMsg}`,
        getMainMenuButtons()
      );
      return;
    }

    if (state.attempts >= state.maxAttempts) {
      const lostScore = await processLossScore(env, chatId, state.level, state.length);
      await env.GAME_KV.delete(`game_${chatId}`);
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId,
        `[失败] 已达到最大尝试次数限制 (${state.maxAttempts} 次)。\n` +
        `扣除积分: -${lostScore}\n` +
        `正确密码是: ${state.secret}\n\n` +
        `历史记录:\n${state.history.join("\n")}`,
        getMainMenuButtons()
      );
      return;
    }

    await env.GAME_KV.put(`game_${chatId}`, JSON.stringify(state), { expirationTtl: 1800 });
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId,
      `反馈结果: ${feedback} (2=位置对, 1=数字对位置错, 0=无此数字)\n剩余次数: ${remaining}\n\n` +
      `近期历史:\n${state.history.slice(-8).join("\n")}`,
      getInGameButtons(length)
    );
  }
}

function compareCodeNoDuplicates(guess, secret, length) {
  const g = guess.split('');
  const s = secret.split('');
  const result = new Array(length).fill(0);

  for (let i = 0; i < length; i++) {
    if (g[i] === s[i]) {
      result[i] = 2;
    } else if (s.includes(g[i])) {
      result[i] = 1;
    } else {
      result[i] = 0;
    }
  }

  const feedback = result.join('');
  return { feedback, isWin: feedback === "2".repeat(length) };
}

// Telegram API Helper
async function sendMessage(token, chatId, text, replyMarkup = null) {
  const body = { chat_id: chatId, text: text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function editMessage(token, chatId, messageId, text, replyMarkup = null) {
  const body = { chat_id: chatId, message_id: messageId, text: text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  await fetch(`https://api.telegram.org/bot${token}/editMessageText`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function answerCallbackQuery(token, callbackQueryId, text = null) {
  const body = { callback_query_id: callbackQueryId };
  if (text) body.text = text;
  await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

