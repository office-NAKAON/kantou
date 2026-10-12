/**
 * デプロイ
 * 1. Googleスプレッドシートを新規作成する
 * 2. 拡張機能 → Apps Script
 * 3. コード.gs の中身を、このファイルの中身に差し替える
 * 4. ＋ → HTML を追加し、ファイル名を Index にする。中身は Index.html
 * 5. デプロイ → 新しいデプロイ → 種類: ウェブアプリ
 *    実行するユーザー: 自分
 *    アクセスできるユーザー: 全員
 * 6. 表示されたURLを生徒に配る
 * スプレッドシート本体は生徒に共有しない
 */

var THEME_NAMES = ["自然", "機能", "空間", "産業", "地域"];
var STANCE_LABEL = {
  ok: "持続できる",
  hard: "持続は難しい",
  cond: "条件がそろえば持続できる"
};
var STANCE_ID = {
  "持続できる": "ok",
  "持続は難しい": "hard",
  "条件がそろえば持続できる": "cond"
};
var STATE_LABEL = {
  idle: "未",
  waiting: "待ち",
  paired: "決定",
  done: "終了",
  none: "相手なし"
};
var STATE_ID = {
  "未": "idle",
  "待ち": "waiting",
  "決定": "paired",
  "終了": "done",
  "相手なし": "none"
};
var STUDENT_HEADERS = ["組", "番号", "氏名", "学習前", "学習後", "比べたこと", "パスワード"];
var JUDGE_HEADERS = ["組", "番号", "氏名", "回", "見方", "最初の立場", "最初の理由", "残した立場", "残した理由", "1人目状態", "1人目", "1人目番号", "2人目状態", "2人目", "2人目番号"];

function doGet() {
  ensureSheets_();
  return HtmlService.createHtmlOutputFromFile("Index")
    .setTitle("東京は50年後も日本の中心か")
    .addMetaTag("viewport", "width=device-width, initial-scale=1")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function api(action, payload) {
  var reading = action === "state" || action === "roster";
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(reading ? 3000 : 20000)) {
    throw new Error(reading ? "待ち" : "いま混み合っています。もう一度押してください。");
  }
  try {
    ensureSheets_();
    var body = payload || {};
    if (action === "roster") return handleRoster_(body);
    if (action === "enter") return handleEnter_(body);
    var found = locate_(body);
    if (action === "state") return { me: viewStudent_(found) };
    if (action === "before") handleBefore_(found.student, body);
    else if (action === "judge") handleJudge_(found.student, body);
    else if (action === "wave") handleWave_(found, body);
    else if (action === "finish") handleFinish_(found.student, body);
    else if (action === "commit") handleCommit_(found.student, body);
    else if (action === "after") handleAfter_(found.student, body);
    else if (action === "reflect") handleReflect_(found.student, body);
    else throw new Error("見つかりません");
    saveClass_(found.cls);
    return { me: viewStudent_(found) };
  } finally {
    lock.releaseLock();
  }
}

function spreadsheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) throw new Error("スプレッドシートの拡張機能から、このスクリプトを開いてください");
  return ss;
}

function ensureSheets_() {
  var ss = spreadsheet_();
  if (!ss.getSheetByName("生徒")) {
    var first = ss.getSheets()[0];
    if (first.getLastRow() === 0 && ss.getSheets().length === 1) first.setName("生徒");
  }
  ensureSheet_("生徒", STUDENT_HEADERS);
  ensureSheet_("判断", JUDGE_HEADERS);
}

function ensureSheet_(name, headers) {
  var ss = spreadsheet_();
  var sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  var width = Math.max(sheet.getLastColumn(), headers.length, 1);
  var current = sheet.getRange(1, 1, 1, width).getValues()[0];
  if (!sheet.getLastRow() && !String(current[0] || "")) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold").setBackground("#ffe566");
    sheet.setFrozenRows(1);
  } else if (String(current[0] || "") !== headers[0]) {
    throw new Error(name + "シートの1行目が見出しではありません");
  } else {
    for (var c = 0; c < headers.length; c++) {
      var found = String(current[c] || "");
      if (found === headers[c]) continue;
      if (found) throw new Error(name + "シートの見出しが違います");
      sheet.getRange(1, c + 1).setValue(headers[c]).setFontWeight("bold").setBackground("#ffe566");
    }
  }
  if (name === "生徒") sheet.getRange("G:G").setNumberFormat("@");
  return sheet;
}

function normNumber_(value) {
  var text = String(value === null || value === undefined ? "" : value).trim();
  if (!/^\d{1,2}$/.test(text)) return "";
  var number = String(Number(text));
  return number === "0" ? "" : number;
}

function normClass_(value) {
  var text = String(value === null || value === undefined ? "" : value).trim();
  return /^[1-6]$/.test(text) ? text : "";
}

function normPassword_(value) {
  if (typeof value === "number" && isFinite(value) && value >= 0 && value <= 9999 && Math.floor(value) === value) {
    return ("0000" + String(value)).slice(-4);
  }
  var text = String(value === null || value === undefined ? "" : value).trim().replace(/[０-９]/g, function(ch) {
    return String.fromCharCode(ch.charCodeAt(0) - 0xFEE0);
  });
  return /^\d{4}$/.test(text) ? text : "";
}

function passwordAttempts_(student, update) {
  var key = "pw:" + student.classNo + ":" + student.number;
  try {
    var cache = CacheService.getScriptCache();
    if (update === "clear") {
      cache.remove(key);
      return 0;
    }
    var fails = Number(cache.get(key) || "0");
    if (update === "read") return fails;
    fails += 1;
    cache.put(key, String(fails), 300);
    return fails;
  } catch (e) {
    return 0;
  }
}

function assertPassword_(student, password) {
  if (!student.password) throw new Error("パスワードがまだ設定されていません。先生に確認してください。");
  if (passwordAttempts_(student, "read") >= 5) throw new Error("しばらく待ってから、もう一度入れてください");
  if (student.password !== password) {
    passwordAttempts_(student, "add");
    throw new Error("パスワードが違います");
  }
  passwordAttempts_(student, "clear");
}

function clip_(value, max) {
  return String(value === null || value === undefined ? "" : value).trim().slice(0, max);
}

function safeText_(value) {
  var text = String(value || "");
  if (/^[=+\-@]/.test(text)) return "'" + text;
  return text;
}

function emptyTheme_() {
  return {
    row: 0,
    draftStance: "",
    draftReason: "",
    finalStance: "",
    finalReason: "",
    waves: [
      { state: "idle", partnerId: "", partnerName: "" },
      { state: "idle", partnerId: "", partnerName: "" }
    ]
  };
}

function emptyStudent_(classNo, number, name) {
  return {
    row: 0,
    classNo: classNo,
    number: number,
    name: name,
    before: "",
    after: "",
    reflect: "",
    password: "",
    dirty: false,
    talkedWith: [],
    themes: [emptyTheme_(), emptyTheme_(), emptyTheme_(), emptyTheme_(), emptyTheme_()]
  };
}

function touch_(student) {
  student.dirty = true;
}

function rebuildTalked_(student) {
  var seen = {};
  var list = [];
  student.themes.forEach(function(theme) {
    theme.waves.forEach(function(wave) {
      if ((wave.state === "paired" || wave.state === "done") && wave.partnerId && !seen[wave.partnerId]) {
        seen[wave.partnerId] = true;
        list.push({ id: String(wave.partnerId), name: wave.partnerName });
      }
    });
  });
  student.talkedWith = list;
}

function loadClass_(classNo) {
  var students = {};
  var studentSheet = spreadsheet_().getSheetByName("生徒");
  var studentValues = studentSheet.getDataRange().getValues();
  for (var i = 1; i < studentValues.length; i++) {
    var row = studentValues[i];
    if (normClass_(row[0]) !== classNo) continue;
    var number = normNumber_(row[1]);
    if (!number) continue;
    var student = emptyStudent_(classNo, number, String(row[2] || ""));
    student.row = i + 1;
    student.before = String(row[3] || "");
    student.after = String(row[4] || "");
    student.reflect = String(row[5] || "");
    student.password = normPassword_(row[6]);
    students[number] = student;
  }

  var judgeSheet = spreadsheet_().getSheetByName("判断");
  var judgeValues = judgeSheet.getDataRange().getValues();
  for (var j = 1; j < judgeValues.length; j++) {
    var item = judgeValues[j];
    if (normClass_(item[0]) !== classNo) continue;
    var studentNumber = normNumber_(item[1]);
    var student = students[studentNumber];
    if (!student) continue;
    var themeIndex = Number(item[3]) - 1;
    if (themeIndex < 0 || themeIndex > 4) continue;
    var theme = student.themes[themeIndex];
    theme.row = j + 1;
    theme.draftStance = STANCE_ID[String(item[5] || "")] || "";
    theme.draftReason = String(item[6] || "");
    theme.finalStance = STANCE_ID[String(item[7] || "")] || "";
    theme.finalReason = String(item[8] || "");
    theme.waves[0] = waveFrom_(item[9], item[10], item[11]);
    theme.waves[1] = waveFrom_(item[12], item[13], item[14]);
  }

  Object.keys(students).forEach(function(id) {
    rebuildTalked_(students[id]);
  });
  return { classNo: classNo, students: students };
}

function waveFrom_(stateLabel, name, id) {
  return {
    state: STATE_ID[String(stateLabel || "")] || "idle",
    partnerName: String(name || ""),
    partnerId: id === "" || id === null || id === undefined ? "" : String(id)
  };
}

function themeToRow_(student, theme, index) {
  return [
    student.classNo,
    student.number,
    safeText_(student.name),
    index + 1,
    THEME_NAMES[index],
    STANCE_LABEL[theme.draftStance] || "",
    safeText_(theme.draftReason),
    STANCE_LABEL[theme.finalStance] || "",
    safeText_(theme.finalReason),
    STATE_LABEL[theme.waves[0].state] || "未",
    safeText_(theme.waves[0].partnerName),
    theme.waves[0].partnerId || "",
    STATE_LABEL[theme.waves[1].state] || "未",
    safeText_(theme.waves[1].partnerName),
    theme.waves[1].partnerId || ""
  ];
}

function ensureThemeRows_(student) {
  var sheet = spreadsheet_().getSheetByName("判断");
  student.themes.forEach(function(theme, index) {
    if (theme.row) return;
    sheet.appendRow(themeToRow_(student, theme, index));
    theme.row = sheet.getLastRow();
  });
}

function saveStudent_(student) {
  var studentSheet = spreadsheet_().getSheetByName("生徒");
  if (!student.row) {
    studentSheet.appendRow([student.classNo, student.number, safeText_(student.name), safeText_(student.before), safeText_(student.after), safeText_(student.reflect)]);
    student.row = studentSheet.getLastRow();
  } else {
    studentSheet.getRange(student.row, 1, 1, 6).setValues([[
      student.classNo,
      student.number,
      safeText_(student.name),
      safeText_(student.before),
      safeText_(student.after),
      safeText_(student.reflect)
    ]]);
  }
  ensureThemeRows_(student);
  var judgeSheet = spreadsheet_().getSheetByName("判断");
  student.themes.forEach(function(theme, index) {
    judgeSheet.getRange(theme.row, 1, 1, 15).setValues([themeToRow_(student, theme, index)]);
  });
  student.dirty = false;
}

function saveClass_(cls) {
  Object.keys(cls.students).forEach(function(id) {
    if (cls.students[id].dirty) saveStudent_(cls.students[id]);
  });
}

function locate_(body) {
  var classNo = normClass_(body.classNo);
  var number = normNumber_(body.number);
  var name = clip_(body.name, 40);
  var password = normPassword_(body.password);
  if (!classNo || !number || !name || !password) throw new Error("もう一度入り直してください");
  var cls = loadClass_(classNo);
  var student = cls.students[number];
  if (!student || student.name !== name) throw new Error("もう一度入り直してください");
  assertPassword_(student, password);
  return { classNo: classNo, number: number, student: student, cls: cls };
}

function handleRoster_(body) {
  var classNo = normClass_(body.classNo);
  if (!classNo) throw new Error("組を選んでください");
  var cls = loadClass_(classNo);
  var students = Object.keys(cls.students).map(function(id) {
    return { number: cls.students[id].number, name: cls.students[id].name };
  }).filter(function(student) {
    return student.number && student.name;
  }).sort(function(a, b) {
    return Number(a.number) - Number(b.number);
  });
  return { students: students };
}

function handleEnter_(body) {
  var classNo = normClass_(body.classNo);
  var number = normNumber_(body.number);
  var name = clip_(body.name, 40);
  var password = normPassword_(body.password);
  if (!classNo || !number || !name || !password) throw new Error("組、氏名、4桁のパスワードを入れてください");
  var cls = loadClass_(classNo);
  var existing = cls.students[number];
  if (!existing || existing.name !== name) throw new Error("名簿にありません");
  assertPassword_(existing, password);
  return { me: viewStudent_({ classNo: classNo, number: number, student: existing, cls: cls }) };
}

function handleBefore_(student, body) {
  var text = clip_(body.text, 2000);
  if (!text) throw new Error("学習前の答えを書いてください");
  student.before = text;
  touch_(student);
}

function themeIndex_(value) {
  var theme = Number(value);
  if (!isFinite(theme) || Math.floor(theme) !== theme || theme < 0 || theme > 4) throw new Error("見方が正しくありません");
  return theme;
}

function waveIndex_(value) {
  var wave = Number(value);
  if (wave !== 0 && wave !== 1) throw new Error("話し合いの回が正しくありません");
  return wave;
}

function assertReady_(student, themeIndex) {
  if (!student.before) throw new Error("学習前を書いてから進みます");
  for (var i = 0; i < themeIndex; i++) {
    if (!student.themes[i].finalStance) throw new Error("前の見方の判断を残してから進みます");
  }
}

function handleJudge_(student, body) {
  var index = themeIndex_(body.theme);
  assertReady_(student, index);
  var theme = student.themes[index];
  if (theme.draftStance) throw new Error("この回の判断は、すでに書いてあります");
  if (!STANCE_LABEL[body.stance]) throw new Error("立場を一つ選んでください");
  var reason = clip_(body.reason, 2000);
  if (!reason) throw new Error("理由を書いてください");
  theme.draftStance = body.stance;
  theme.draftReason = reason;
  touch_(student);
}

function handleWave_(found, body) {
  var index = themeIndex_(body.theme);
  var wave = waveIndex_(body.wave);
  var student = found.student;
  assertReady_(student, index);
  var theme = student.themes[index];
  if (!theme.draftStance) throw new Error("先に判断を書いてください");
  if (wave === 1 && theme.waves[0].state !== "done") throw new Error("1人目が終わってから、2人目に進みます");
  if (theme.waves[wave].state === "idle") {
    theme.waves[wave].state = "waiting";
    touch_(student);
  }
  matchWave_(found.cls, index, wave);
}

function handleFinish_(student, body) {
  var theme = student.themes[themeIndex_(body.theme)];
  var wave = theme.waves[waveIndex_(body.wave)];
  if (wave.state !== "paired" && wave.state !== "none") throw new Error("まだ相手が決まっていません");
  wave.state = "done";
  touch_(student);
}

function handleCommit_(student, body) {
  var theme = student.themes[themeIndex_(body.theme)];
  if (theme.waves.some(function(wave) { return wave.state !== "done"; })) throw new Error("2人との話し合いが終わってから残します");
  if (!STANCE_LABEL[body.stance]) throw new Error("立場を一つ選んでください");
  var reason = clip_(body.reason, 2000);
  if (!reason) throw new Error("理由を書いてください");
  theme.finalStance = body.stance;
  theme.finalReason = reason;
  touch_(student);
}

function handleAfter_(student, body) {
  if (student.themes.some(function(theme) { return !theme.finalStance; })) throw new Error("5つの判断が残ってから書きます");
  var text = clip_(body.text, 2000);
  if (!text) throw new Error("学習後の答えを書いてください");
  student.after = text;
  touch_(student);
}

function handleReflect_(student, body) {
  if (!student.after) throw new Error("学習後を書いてから比べます");
  var text = clip_(body.text, 2000);
  if (!text) throw new Error("思ったこと、感じたことを書いてください");
  student.reflect = text;
  touch_(student);
}

function canPair_(cls, a, b) {
  if (a === b) return false;
  var left = cls.students[a].talkedWith.some(function(person) { return person.id === b; });
  var right = cls.students[b].talkedWith.some(function(person) { return person.id === a; });
  return !left && !right;
}

function linkStudents_(cls, themeIndex, waveIndex, a, b) {
  var left = cls.students[a];
  var right = cls.students[b];
  var leftWave = left.themes[themeIndex].waves[waveIndex];
  var rightWave = right.themes[themeIndex].waves[waveIndex];
  leftWave.state = "paired";
  leftWave.partnerId = b;
  leftWave.partnerName = right.name;
  rightWave.state = "paired";
  rightWave.partnerId = a;
  rightWave.partnerName = left.name;
  left.talkedWith.push({ id: b, name: right.name });
  right.talkedWith.push({ id: a, name: left.name });
  touch_(left);
  touch_(right);
}

function matchWave_(cls, themeIndex, waveIndex) {
  var submitted = Object.keys(cls.students).filter(function(id) {
    var theme = cls.students[id].themes[themeIndex];
    return theme.draftStance && theme.draftReason;
  });
  function waveOf(id) {
    return cls.students[id].themes[themeIndex].waves[waveIndex];
  }
  var locked = {};
  submitted.forEach(function(id) {
    var state = waveOf(id).state;
    if (state === "paired" || state === "done" || state === "none") locked[id] = true;
  });
  var waiting = submitted.filter(function(id) {
    return waveOf(id).state === "waiting" && !locked[id];
  }).sort(function(a, b) { return Number(a) - Number(b); });

  for (var i = 0; i < waiting.length; i++) {
    if (locked[waiting[i]]) continue;
    for (var j = i + 1; j < waiting.length; j++) {
      if (locked[waiting[j]]) continue;
      if (!canPair_(cls, waiting[i], waiting[j])) continue;
      linkStudents_(cls, themeIndex, waveIndex, waiting[i], waiting[j]);
      locked[waiting[i]] = true;
      locked[waiting[j]] = true;
      break;
    }
  }

  var stillWriting = submitted.some(function(id) { return waveOf(id).state === "idle"; });
  if (stillWriting) return;

  var leftovers = submitted.filter(function(id) { return waveOf(id).state === "waiting"; })
    .sort(function(a, b) { return Number(a) - Number(b); });
  if (!leftovers.length) return;

  var stranded = leftovers.length === 1
    ? leftovers
    : leftovers.filter(function(id) {
      return !leftovers.some(function(other) { return other !== id && canPair_(cls, id, other); });
    });
  if (leftovers.length > 1 && !stranded.length) return;

  var teacherTaken = submitted.some(function(id) { return waveOf(id).partnerId === "teacher"; });
  var teacherGiven = teacherTaken;
  stranded.forEach(function(id) {
    var student = cls.students[id];
    var wave = waveOf(id);
    var hadTeacher = student.talkedWith.some(function(person) { return person.id === "teacher"; });
    if (!teacherGiven && !hadTeacher) {
      wave.state = "paired";
      wave.partnerId = "teacher";
      wave.partnerName = "先生";
      student.talkedWith.push({ id: "teacher", name: "先生" });
      teacherGiven = true;
    } else {
      wave.state = "none";
      wave.partnerId = "";
      wave.partnerName = "";
    }
    touch_(student);
  });
}

function decorateWave_(cls, themeIndex, wave) {
  var view = {
    state: wave.state,
    partnerName: wave.partnerName,
    teacher: wave.partnerId === "teacher"
  };
  if ((wave.state === "paired" || wave.state === "done") && wave.partnerId && wave.partnerId !== "teacher") {
    var partner = cls.students[wave.partnerId];
    if (partner) {
      view.partnerStance = partner.themes[themeIndex].draftStance;
      view.partnerReason = partner.themes[themeIndex].draftReason;
    }
  }
  return view;
}

function viewStudent_(found) {
  var student = found.student;
  return {
    classNo: found.classNo,
    number: found.number,
    name: student.name,
    before: student.before,
    after: student.after,
    reflect: student.reflect,
    talked: student.talkedWith,
    themes: student.themes.map(function(theme, themeIndex) {
      return {
        draftStance: theme.draftStance,
        draftReason: theme.draftReason,
        finalStance: theme.finalStance,
        finalReason: theme.finalReason,
        waves: theme.waves.map(function(wave) { return decorateWave_(found.cls, themeIndex, wave); })
      };
    })
  };
}
