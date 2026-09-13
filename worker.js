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
            "[错误] 内容只支持中文、英文、数字和常用标点，不能包含表情或特殊符号！"
          );
          return new Response("OK", { status: 200 });
        }

        // 优先处理多步对话（输入用户名、邀请码等）
        const handledStep = await handleStepInput(env, chatId, text);
        if (handledStep) return new Response("OK", { status: 200 });

        // 处理用户与管理员指令
        const handledCmd = await handleUserCommands(env, chatId, text);
        if (handledCmd) return new Response("OK", { status: 200 });

        // 处理游戏菜单与常规游戏输入
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

// ==================== 配置与常量 ====================
const GUESS_WORST_CASE = { 1: 4, 2: 7, 3: 10, 4: 14, 5: 17, 6: 20, 7: 24, 8: 27, 9: 30, 10: 34 };
const BULLS_WORST_CASE = { 1: 10, 2: 6, 3: 7, 4: 7, 5: 8, 6: 8, 7: 9, 8: 9, 9: 10, 10: 10 };
const INVITE_EXPIRE_SECONDS = 3 * 24 * 60 * 60; // 3 天
const NO_PERMISSION_MSG = "你无权限此操作，请联系管理员";

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

  if (!user.username) {
    user.username = `玩家_${chatId}`;
  }

  if (!user.progress) {
    user.progress = {
      guess: { maxUnlockedLength: 1, maxUnlockedLevel: 1, timesPassed: 0 },
      bulls: { maxUnlockedLength: 1, maxUnlockedLevel: 1, timesPassed: 0 }
    };
  }
  return user;
}

async function saveUser(env, chatId, user) {
  await env.GAME_KV.put(`user_${chatId}`, JSON.stringify(user));
}

// 从全局邀请码主列表中同步移除
async function removeCodeFromList(env, code) {
  const rawList = await env.GAME_KV.get("active_invite_codes");
  if (!rawList) return;
  let codeList = JSON.parse(rawList);
  codeList = codeList.filter(item => item.code !== code);
  await env.GAME_KV.put("active_invite_codes", JSON.stringify(codeList));
}

// ==================== 分步对话状态处理器 ====================
async function handleStepInput(env, chatId, text) {
  const stepState = await env.GAME_KV.get(`step_${chatId}`);
  if (!stepState) return false;

  const stepData = JSON.parse(stepState);

  // 取消流程
  if (text.toLowerCase() === "/cancel") {
    await env.GAME_KV.delete(`step_${chatId}`);
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "[提示] 当前输入流程已取消。");
    return true;
  }

  if (stepData.action === "REGISTER_NAME") {
    stepData.tempUsername = text.trim();
    const config = await getGlobalConfig(env);

    if (config.requireInvite && config.hasSuperAdmin) {
      stepData.action = "REGISTER_CODE";
      await env.GAME_KV.put(`step_${chatId}`, JSON.stringify(stepData), { expirationTtl: 300 });
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `用户名已设定为: ${stepData.tempUsername}\n\n当前已开启邀请制，请输入你的【邀请码】：\n(随时可发送 /cancel 取消注册)`);
    } else {
      await env.GAME_KV.delete(`step_${chatId}`);
      await completeRegistration(env, chatId, stepData.tempUsername);
    }
    return true;
  }

  if (stepData.action === "REGISTER_CODE") {
    const inviteCodeInput = text.trim();
    const inviteData = await env.GAME_KV.get(`invite_${inviteCodeInput}`);
    if (!inviteData) {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "[注册失败] 邀请码无效、不存在或已过期！请重新输入邀请码，或发送 /cancel 取消：");
      return true;
    }

    // 销毁使用过的邀请码（KV + 实时主列表同步）
    await env.GAME_KV.delete(`invite_${inviteCodeInput}`);
    await removeCodeFromList(env, inviteCodeInput);
    await env.GAME_KV.delete(`step_${chatId}`);

    await completeRegistration(env, chatId, stepData.tempUsername);
    return true;
  }

  if (stepData.action === "SET_NAME") {
    const newName = text.trim();
    const currentUser = await getUser(env, chatId);
    if (currentUser) {
      currentUser.username = newName;
      await saveUser(env, chatId, currentUser);
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `[修改成功] 你的新用户名已更新为: ${newName}`);
    }
    await env.GAME_KV.delete(`step_${chatId}`);
    return true;
  }

  return false;
}

// 统一完成注册逻辑
async function completeRegistration(env, chatId, username) {
  const config = await getGlobalConfig(env);
  let role = "user";

  if (!config.hasSuperAdmin) {
    role = "super_admin";
    config.hasSuperAdmin = true;
    await saveGlobalConfig(env, config);
  }

  const newUser = {
    chatId: chatId,
    username: username,
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
    `[注册成功！]\n\n` +
    `用户名: ${username}\n` +
    `Telegram ID: ${chatId}\n` +
    `身份级别: ${getRoleName(role)}\n` +
    `初始积分: 0`
  );
}

// ==================== 指令响应逻辑 ====================
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
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `[提示] 你已经注册并处于登录状态。\n用户名: ${currentUser.username} | ID: ${chatId}`);
      return true;
    }

    await env.GAME_KV.put(`step_${chatId}`, JSON.stringify({ action: "REGISTER_NAME" }), { expirationTtl: 300 });
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "欢迎注册！直接发送你想设置的【用户名】：\n(可随时发送 /cancel 取消)");
    return true;
  }

  if (cmd === "/setname") {
    if (!currentUser || !currentUser.isLoggedIn) {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "[修改失败] 请先登录账号。");
      return true;
    }

    await env.GAME_KV.put(`step_${chatId}`, JSON.stringify({ action: "SET_NAME" }), { expirationTtl: 300 });
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "直接发送你的【新用户名】：\n(可随时发送 /cancel 取消)");
    return true;
  }

  if (cmd === "/login") {
    if (!currentUser) {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "[登录失败] 账号不存在，请发送 /register 进行注册。");
      return true;
    }
    currentUser.isLoggedIn = true;
    await saveUser(env, chatId, currentUser);
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `[登录成功] 欢迎回来，${currentUser.username}！| 身份: ${getRoleName(currentUser.role)}`);
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
      `用户名: ${currentUser.username}\n` +
      `Telegram ID: ${currentUser.chatId}\n` +
      `权限等级: ${getRoleName(currentUser.role)}\n` +
      `当前积分: ${currentUser.score} | 总胜场: ${currentUser.wins}\n\n` +
      `【关卡解锁进度】${isDisabled ? " (已关锁)" : ""}\n` +
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
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, NO_PERMISSION_MSG);
      return true;
    }
    const newCode = "SYS_" + Math.random().toString(36).substring(2, 8).toUpperCase();
    const creatorInfo = `生成者:${currentUser.username}(${chatId})`;

    // 1. 写入独立键
    await env.GAME_KV.put(`invite_${newCode}`, creatorInfo, { expirationTtl: INVITE_EXPIRE_SECONDS });

    // 2. 实时同步保存至全局聚合列表（无延迟）
    const rawList = await env.GAME_KV.get("active_invite_codes");
    let codeList = rawList ? JSON.parse(rawList) : [];
    codeList.push({ code: newCode, info: creatorInfo, expireAt: Date.now() + (INVITE_EXPIRE_SECONDS * 1000) });
    await env.GAME_KV.put("active_invite_codes", JSON.stringify(codeList));

    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `[生成成功] 邀请码: ${newCode}\n(3天内有效，仅可使用一次)`);
    return true;
  }

  if (cmd === "/invite_list") {
    if (ROLE_LEVEL[currentUser.role] < ROLE_LEVEL.mid_admin) {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, NO_PERMISSION_MSG);
      return true;
    }

    const rawList = await env.GAME_KV.get("active_invite_codes");
    let codeList = rawList ? JSON.parse(rawList) : [];
    const now = Date.now();

    // 自动过滤已过期的邀请码
    codeList = codeList.filter(item => item.expireAt > now);
    await env.GAME_KV.put("active_invite_codes", JSON.stringify(codeList));

    if (codeList.length === 0) {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "[邀请码列表] 当前没有任何有效邀请码。");
      return true;
    }

    let resultText = "=== 现有有效邀请码列表 ===\n\n";
    for (const item of codeList) {
      resultText += `邀请码: ${item.code} | ${item.info}\n`;
    }
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, resultText);
    return true;
  }

  if (cmd === "/del_code") {
    if (currentUser.role !== "super_admin") {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, NO_PERMISSION_MSG);
      return true;
    }
    const targetCode = parts[1] ? parts[1].trim() : "";
    if (!targetCode) {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "格式错误: /del_code <要删除的邀请码>");
      return true;
    }
    const exists = await env.GAME_KV.get(`invite_${targetCode}`);
    if (!exists) {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, "[删除失败] 找不到该邀请码或已被使用/过期。");
      return true;
    }
    
    // 双重清理
    await env.GAME_KV.delete(`invite_${targetCode}`);
    await removeCodeFromList(env, targetCode);

    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `[成功] 已强行清空/删除邀请码: ${targetCode}`);
    return true;
  }

  if (cmd === "/toggle_invite") {
    if (ROLE_LEVEL[currentUser.role] < ROLE_LEVEL.mid_admin) {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, NO_PERMISSION_MSG);
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
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, NO_PERMISSION_MSG);
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
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, NO_PERMISSION_MSG);
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
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `[成功] 已将用户 ${targetUser.username}(${targetChatId}) 权限修改为: ${getRoleName(targetRole)}`);
    return true;
  }

  if (cmd === "/ban") {
    if (currentUser.role !== "super_admin") {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, NO_PERMISSION_MSG);
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
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `[成功] 已封禁用户 ${targetUser.username}(${targetChatId})！`);
    return true;
  }

  if (cmd === "/unban") {
    if (currentUser.role !== "super_admin") {
      await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, NO_PERMISSION_MSG);
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
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, `[成功] 已解除用户 ${targetUser.username}(${targetChatId}) 的封禁！`);
    return true;
  }

  return false;
}

async function sendHelpMenu(env, chatId, user) {
  let helpText = "=== 游戏指令帮助菜单 ===\n\n";

  helpText += "【基础指令】\n";
  helpText += "/register - 注册新账号 (发送名称/邀请码)\n";
  helpText += "/setname - 修改你的用户名 (直接发送新名字)\n";
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
    helpText += "/del_code <邀请码> - 强行删除指定邀请码\n";
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
    rankText += `第 ${index + 1} 名 | ${u.username || '玩家'} (ID: ${u.chatId}) | 积分: ${u.score} (胜场: ${u.wins})\n`;
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
    `玩家: ${user ? user.username : '游客'} | ID: ${chatId}\n\n` +
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

// ==================== 游戏逻辑与积分结算 ====================
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
