// Nếu thầy đổi endpoint, chỉ cần thay URL tại đây.
    const API_URL = window.POSTTOOL_CONFIG?.apiUrl || "/api/task";

    if (window.pdfjsLib) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = window.POSTTOOL_CONFIG?.pdfWorkerUrl || "/vendor/pdfjs/pdf.worker.min.js";
    }
    const PDF_MAX_BYTES = 3 * 1024 * 1024;
    const mediaTypeCache = new Map();

    const axiosClient = window.axios ? window.axios.create({
      timeout: 15000,
      headers: { Accept: "application/json, text/plain, */*" }
    }) : null;

    function sleepClient(ms) {
      return new Promise(resolve => setTimeout(resolve, ms));
    }

    function axiosStatus(error) {
      return Number(error?.response?.status || 0);
    }

    function axiosRetryable(error) {
      const status = axiosStatus(error);
      return !status || status === 408 || status === 425 || status === 429 || status >= 500
        || error?.code === "ECONNABORTED" || error?.code === "ERR_NETWORK" || error?.code === "ETIMEDOUT";
    }

    function axiosErrorMessage(error) {
      const status = axiosStatus(error);
      const data = error?.response?.data;
      const detail = data && typeof data === "object" ? (data.error || data.detail) : "";
      if (detail) return String(detail);
      if (status) return `HTTP ${status}`;
      return String(error?.message || "Không kết nối được máy chủ.");
    }

    async function axiosRequestWithRetry(config, { retries = 2, baseDelay = 320 } = {}) {
      if (!axiosClient) throw new Error("Thư viện Axios chưa tải được.");
      let lastError = null;
      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          return await axiosClient.request(config);
        } catch (error) {
          lastError = error;
          if (!axiosRetryable(error) || attempt >= retries) throw error;
          const jitter = Math.floor(Math.random() * 260);
          await sleepClient(Math.min(2200, baseDelay * (2 ** attempt)) + jitter);
        }
      }
      throw lastError || new Error("Không gửi được yêu cầu.");
    }


    // Luôn tải API mới khi reload. Nếu API không đổi thì khôi phục tiến trình;
    // nếu API thay đổi thì reset bài làm và chỉ giữ Họ tên + Lớp.
    const LAST_ID_KEY = "student_reflection_last_identity_v5";
    const API_SIGNATURE_KEY = "student_reflection_api_signature_v1";
    const API_DATA_KEY = "student_reflection_api_data_v1";
    const PROGRESS_PREFIX = "student_reflection_progress_v6__";

    const PROGRESS_DB_NAME = "posttool_progress_db";
    const PROGRESS_DB_VERSION = 1;
    const PROGRESS_STORE = "progress";
    let progressDbPromise = null;

    function safeLocalGet(key) {
      try { return localStorage.getItem(key); } catch (_) { return null; }
    }

    function safeLocalSet(key, value) {
      try { localStorage.setItem(key, value); return true; } catch (_) { return false; }
    }

    function safeLocalRemove(key) {
      try { localStorage.removeItem(key); } catch (_) {}
    }

    function openProgressDb() {
      if (!window.indexedDB) return Promise.resolve(null);
      if (!progressDbPromise) {
        progressDbPromise = new Promise(resolve => {
          try {
            const req = indexedDB.open(PROGRESS_DB_NAME, PROGRESS_DB_VERSION);
            req.onupgradeneeded = () => {
              const db = req.result;
              if (!db.objectStoreNames.contains(PROGRESS_STORE)) db.createObjectStore(PROGRESS_STORE);
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => resolve(null);
            req.onblocked = () => resolve(null);
          } catch (_) { resolve(null); }
        });
      }
      return progressDbPromise;
    }

    async function idbPutProgress(key, value) {
      const db = await openProgressDb();
      if (!db) return false;
      return new Promise(resolve => {
        try {
          const tx = db.transaction(PROGRESS_STORE, "readwrite");
          tx.objectStore(PROGRESS_STORE).put(value, key);
          tx.oncomplete = () => resolve(true);
          tx.onerror = () => resolve(false);
          tx.onabort = () => resolve(false);
        } catch (_) { resolve(false); }
      });
    }

    async function idbGetProgress(key) {
      const db = await openProgressDb();
      if (!db) return null;
      return new Promise(resolve => {
        try {
          const tx = db.transaction(PROGRESS_STORE, "readonly");
          const req = tx.objectStore(PROGRESS_STORE).get(key);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => resolve(null);
        } catch (_) { resolve(null); }
      });
    }

    async function idbClearProgress() {
      const db = await openProgressDb();
      if (!db) return;
      await new Promise(resolve => {
        try {
          const tx = db.transaction(PROGRESS_STORE, "readwrite");
          tx.objectStore(PROGRESS_STORE).clear();
          tx.oncomplete = resolve;
          tx.onerror = resolve;
          tx.onabort = resolve;
        } catch (_) { resolve(); }
      });
    }


    async function getStoredApiSignature() {
      const local = safeLocalGet(API_SIGNATURE_KEY);
      if (local) return local;
      const stored = await idbGetProgress("__api_signature__");
      return typeof stored === "string" ? stored : "";
    }

    async function setStoredApiSignature(signature) {
      safeLocalSet(API_SIGNATURE_KEY, signature);
      await idbPutProgress("__api_signature__", signature);
    }


    async function getStoredApiData() {
      const local = safeJSON(safeLocalGet(API_DATA_KEY));
      if (Array.isArray(local) && local.length) return local;
      const stored = await idbGetProgress("__api_data__");
      return Array.isArray(stored) ? stored : [];
    }

    async function setStoredApiData(questionList) {
      const clean = Array.isArray(questionList) ? questionList : [];
      const json = JSON.stringify(clean);
      if (json.length <= 1_500_000) safeLocalSet(API_DATA_KEY, json);
      else safeLocalRemove(API_DATA_KEY);
      await idbPutProgress("__api_data__", clean);
    }

    const els = {
      studentName: document.getElementById("studentName"),
      studentClass: document.getElementById("studentClass"),
      saveStatus: document.getElementById("saveStatus"),
      autoSaveStatus: document.getElementById("autoSaveStatus"),
      questionArea: document.getElementById("questionArea"),
      questionPickerWrap: document.getElementById("questionPickerWrap"),
      questionPicker: document.getElementById("questionPicker"),
      answers: document.getElementById("answers"),
      addAnswerBtn: document.getElementById("addAnswerBtn"),
      exportBtn: document.getElementById("exportBtn")
    };

    let questions = [];
    let currentIndex = 0;
    let answerState = {};
    let identitySaveTimer = null;
    let autoSaveTimer = null;
    let currentApiSignature = "";
    let submissionInFlight = false;
    const illustrationResolveCache = new Map();

    function normalize(s) {
      return String(s ?? "").trim().replace(/\s+/g, " ");
    }


    function appendTextWithLinks(container, value) {
      const text = String(value ?? "");
      const urlRegex = /https?:\/\/[^\s<>"']+/gi;
      let lastIndex = 0;
      let match;

      while ((match = urlRegex.exec(text)) !== null) {
        if (match.index > lastIndex) {
          container.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
        }

        let rawUrl = match[0];
        let trailing = "";
        while (/[.,;:!?)]$/.test(rawUrl)) {
          trailing = rawUrl.slice(-1) + trailing;
          rawUrl = rawUrl.slice(0, -1);
        }

        const link = document.createElement("a");
        link.href = rawUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.className = "detected-link";
        link.textContent = rawUrl;
        container.appendChild(link);
        if (trailing) container.appendChild(document.createTextNode(trailing));

        lastIndex = match.index + match[0].length;
      }

      if (lastIndex < text.length) {
        container.appendChild(document.createTextNode(text.slice(lastIndex)));
      }
    }

    function safeNumber(value, fallback = 0) {
      const n = Number.parseInt(String(value ?? "").trim(), 10);
      return Number.isFinite(n) ? n : fallback;
    }

    function createSubmissionId() {
      try {
        if (window.crypto?.randomUUID) return window.crypto.randomUUID();
      } catch (_) {}
      return `sub_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
    }

    function identityKey() {
      const name = normalize(els.studentName.value).toLocaleLowerCase("vi");
      const cls = normalize(els.studentClass.value).toLocaleLowerCase("vi");
      if (!name || !cls) return "";
      return encodeURIComponent(name + "__" + cls);
    }

    function progressKey() {
      const id = identityKey();
      return id ? PROGRESS_PREFIX + id : "";
    }

    function saveIdentity() {
      const studentName = normalize(els.studentName.value);
      const studentClass = normalize(els.studentClass.value);
      try {
        safeLocalSet(LAST_ID_KEY, JSON.stringify({ studentName, studentClass }));
      } catch (error) {
        console.warn("Không thể lưu Họ tên + Lớp trên trình duyệt:", error);
      }
    }

    function scheduleIdentitySave() {
      clearTimeout(identitySaveTimer);
      identitySaveTimer = setTimeout(saveIdentity, 300);
    }

    function restoreIdentity() {
      const last = safeJSON(safeLocalGet(LAST_ID_KEY))
        || safeJSON(safeLocalGet("student_reflection_last_identity_v4"))
        || safeJSON(safeLocalGet("student_reflection_last_identity_v3"));
      if (!last) return;
      els.studentName.value = String(last.studentName || "");
      els.studentClass.value = String(last.studentClass || "");
      saveIdentity();
    }

    async function clearStoredProgress() {
      const keysToRemove = [];
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i) || "";
          if (key.startsWith(PROGRESS_PREFIX)
              || key.startsWith("student_reflection_progress_v3__")
              || key.startsWith("student_reflection_progress_v4__")
              || key.startsWith("student_reflection_progress_v5__")) {
            keysToRemove.push(key);
          }
        }
      } catch (_) {}
      keysToRemove.forEach(safeLocalRemove);
      await idbClearProgress();
    }

    function stableStringify(value) {
      if (value === null || typeof value !== "object") return JSON.stringify(value);
      if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
      const keys = Object.keys(value).sort((a, b) => a.localeCompare(b, "vi"));
      return "{" + keys.map(key => JSON.stringify(key) + ":" + stableStringify(value[key])).join(",") + "}";
    }

    function apiSignatureFor(questionList) {
      // Dùng chuỗi chuẩn hóa thay vì JSON.stringify trực tiếp để việc đổi thứ tự key
      // không bị hiểu nhầm là API thay đổi. Mọi thay đổi giá trị/nội dung vẫn được phát hiện.
      return stableStringify(questionList);
    }

    function serializeProgress() {
      captureCurrentBoxSizes();
      return {
        version: 6,
        apiSignature: currentApiSignature,
        studentName: normalize(els.studentName.value),
        studentClass: normalize(els.studentClass.value),
        currentIndex,
        answerState,
        savedAt: new Date().toISOString()
      };
    }

    function saveProgress({ silent = true } = {}) {
      const key = progressKey();
      if (!key || !currentApiSignature || !questions.length) return false;
      const data = serializeProgress();
      const json = JSON.stringify(data);
      // IndexedDB handles pasted images much more reliably than localStorage.
      void idbPutProgress(key, data);
      if (json.length <= 1_800_000) safeLocalSet(key, json);
      else safeLocalRemove(key);
      saveIdentity();
      if (!silent && !window.indexedDB && json.length > 1_800_000) {
        alert("Trình duyệt này có dung lượng lưu tiến trình hạn chế. Hãy nộp bài trước khi đóng trang.");
      }
      return true;
    }

    function scheduleAutoSave() {
      clearTimeout(autoSaveTimer);
      primeCurrentIllustrations();
      autoSaveTimer = setTimeout(() => saveProgress({ silent: true }), 2500);
    }

    async function restoreProgressIfCompatible() {
      const key = progressKey();
      if (!key) return false;
      const fromLocal = safeJSON(safeLocalGet(key));
      const fromDb = await idbGetProgress(key);
      const candidates = [fromDb, fromLocal].filter(data => data && data.apiSignature === currentApiSignature);
      if (!candidates.length) return false;
      candidates.sort((a, b) => String(b.savedAt || "").localeCompare(String(a.savedAt || "")));
      const data = candidates[0];
      answerState = data.answerState && typeof data.answerState === "object" ? data.answerState : {};
      currentIndex = Math.min(Math.max(0, Number(data.currentIndex || 0)), Math.max(0, questions.length - 1));
      return true;
    }

    function getFieldCaseInsensitive(obj, names) {
      const keys = Object.keys(obj || {});
      for (const wanted of names) {
        const wantedNorm = String(wanted).toLocaleLowerCase("vi").trim();
        const found = keys.find(k => String(k).toLocaleLowerCase("vi").trim() === wantedNorm);
        if (found) return { key: found, value: obj[found] };
      }
      return { key: "", value: "" };
    }

    function findFieldByRegex(obj, regex) {
      const key = Object.keys(obj || {}).find(k => regex.test(String(k).trim()));
      return key ? { key, value: obj[key] } : { key: "", value: "" };
    }

    function displayTitle(q, index) {
      // Trường tiêu đề chuẩn trong API hiện tại là "Title".
      const byName = getFieldCaseInsensitive(q, ["Title", "Tiêu đề", "Tieu de"]);
      return normalize(byName.value) || `Nhiệm vụ ${index + 1}`;
    }

    function displayContent(q) {
      const byName = getFieldCaseInsensitive(q, ["Content", "Nội dung", "Noi dung", "Đề bài", "De bai"]);
      return String(byName.value ?? "").trim();
    }

    function displayStt(q, index) {
      const byName = getFieldCaseInsensitive(q, ["STT", "Số thứ tự", "So thu tu", "ID"]);
      return normalize(byName.value) || String(index + 1);
    }

    function questionKey(index = currentIndex) {
      const q = questions[index] || {};
      const id = getFieldCaseInsensitive(q, ["ID", "STT", "Số thứ tự", "So thu tu"]).value;
      if (normalize(id)) return String(id);
      return `${index + 1}__${displayTitle(q, index)}`;
    }

    function textboxConfig(q) {
      const numberField = getFieldCaseInsensitive(q, [
        "Number of Textbox",
        "Number of Textboxes",
        "Số lượng Textbox",
        "So luong Textbox"
      ]);

      const names = {};
      let highestNameIndex = 0;

      Object.keys(q || {}).forEach(key => {
        const match = String(key).trim().match(/^Textbox\s*name\s*(\d+)$/i);
        if (!match) return;
        const index = Number(match[1]);
        highestNameIndex = Math.max(highestNameIndex, index);
        names[index] = normalize(q[key]);
      });

      const hasNumber = normalize(numberField.value) !== "";
      let count = hasNumber ? safeNumber(numberField.value, 0) : Math.max(highestNameIndex, 1);
      count = Math.max(0, Math.min(30, count));

      const labels = Array.from({ length: count }, (_, i) => {
        const oneBased = i + 1;
        return names[oneBased] || `Ô văn bản ${oneBased}`;
      });

      return { count, labels, names, highestNameIndex };
    }

    function layoutMode(q) {
      const raw = normalize(getFieldCaseInsensitive(q, ["Layout"]).value).toLocaleLowerCase("vi");
      if (!raw) return "vertical";
      if (raw.includes("grid") || raw.includes("dạng lưới") || raw.includes("dang luoi")) return "grid";
      if (raw.includes("split") || raw.includes("chia đôi") || raw.includes("chia doi")) return "split";
      if (raw.includes("single-page") || raw.includes("single page") || raw.includes("một trang") || raw.includes("mot trang") || raw.includes("cuộn dài") || raw.includes("cuon dai")) return "single-page";
      return "vertical";
    }

    function getListImageValue(q) {
      return getFieldCaseInsensitive(q, [
        "List Image",
        "List Images",
        "Image List",
        "Danh sách ảnh",
        "Danh sach anh"
      ]).value;
    }

    function getFolderValue(q) {
      return normalize(getFieldCaseInsensitive(q, [
        "Folder",
        "Report Folder",
        "Google Drive Folder",
        "Thư mục",
        "Thu muc"
      ]).value);
    }

    function parseImageLinks(value) {
      if (Array.isArray(value)) {
        return [...new Set(value.map(x => normalize(x)).filter(isHttpUrl))];
      }

      const raw = String(value ?? "").trim();
      if (!raw) return [];

      // Trường hợp Google Sheet trả một chuỗi JSON dạng ["url1", "url2"]
      if (raw.startsWith("[") && raw.endsWith("]")) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) return parseImageLinks(parsed);
        } catch (_) {}
      }

      // Lấy URL trong chuỗi: hỗ trợ xuống dòng, dấu phẩy, chấm phẩy, dấu | hoặc nhiều URL cách nhau bằng khoảng trắng.
      const found = raw.match(/https?:\/\/[^\s,;|]+/gi) || [];
      if (found.length) return [...new Set(found.map(cleanUrlToken).filter(isHttpUrl))];

      return raw
        .split(/[\n,;|]+/)
        .map(cleanUrlToken)
        .filter(isHttpUrl);
    }

    function cleanUrlToken(value) {
      return String(value ?? "").trim().replace(/^["'(<]+|["')>.,]+$/g, "");
    }

    function isHttpUrl(value) {
      try {
        const u = new URL(String(value));
        return u.protocol === "http:" || u.protocol === "https:";
      } catch (_) {
        return false;
      }
    }

    function googleDriveFolderId(url) {
      const m = String(url).match(/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([a-zA-Z0-9_-]+)/i)
        || String(url).match(/drive\.google\.com\/folders\/([a-zA-Z0-9_-]+)/i);
      return m ? m[1] : "";
    }

    function googleDriveFileId(url) {
      const s = String(url);
      const patterns = [
        /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/i,
        /drive\.google\.com\/open\?[^#]*\bid=([a-zA-Z0-9_-]+)/i,
        /drive\.google\.com\/uc\?[^#]*\bid=([a-zA-Z0-9_-]+)/i,
        /drive\.google\.com\/thumbnail\?[^#]*\bid=([a-zA-Z0-9_-]+)/i
      ];
      for (const re of patterns) {
        const m = s.match(re);
        if (m) return m[1];
      }
      return "";
    }

    function toDisplayImageUrl(url) {
      const fileId = googleDriveFileId(url);
      if (fileId) return `https://drive.google.com/thumbnail?id=${encodeURIComponent(fileId)}&sz=w1600`;
      return url;
    }

    function looksLikePdfUrl(url) {
      const s = String(url || "");
      return /\.pdf(?:$|[?#])/i.test(s) || /(?:[?&](?:format|type|mime)=)(?:application%2Fpdf|application\/pdf|pdf)(?:&|$)/i.test(s);
    }

    function imageSources(q) {
      return parseImageLinks(getListImageValue(q)).map(originalUrl => {
        const folderId = googleDriveFolderId(originalUrl);
        if (folderId) {
          return {
            type: "drive-folder",
            originalUrl,
            folderId,
            embedUrl: `https://drive.google.com/embeddedfolderview?id=${encodeURIComponent(folderId)}#grid`
          };
        }
        const fileId = googleDriveFileId(originalUrl);
        if (looksLikePdfUrl(originalUrl)) {
          return { type: "pdf", originalUrl, fileId };
        }
        if (fileId) {
          return {
            type: "drive-file",
            originalUrl,
            fileId,
            displayUrl: toDisplayImageUrl(originalUrl)
          };
        }
        return {
          type: "image",
          originalUrl,
          displayUrl: toDisplayImageUrl(originalUrl)
        };
      });
    }

    function isConfigField(key) {
      const k = String(key).trim();
      if (/^Textbox\s*name\s*\d+$/i.test(k)) return true;
      const reserved = [
        "Title", "Tiêu đề", "Tieu de",
        "Content", "Nội dung", "Noi dung", "Đề bài", "De bai",
        "List Image", "List Images", "Image List", "Danh sách ảnh", "Danh sach anh",
        "Number of Textbox", "Number of Textboxes", "Số lượng Textbox", "So luong Textbox",
        "Layout", "Folder", "Report Folder", "Google Drive Folder", "Thư mục", "Thu muc",
        "STT", "Số thứ tự", "So thu tu", "ID"
      ];
      return reserved.some(x => x.toLocaleLowerCase("vi") === k.toLocaleLowerCase("vi"));
    }

    function extraFields(q) {
      return Object.entries(q || {}).filter(([k, v]) => !isConfigField(k) && v !== "" && v !== null && v !== undefined);
    }

    function cryptoRandomId() {
      if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
      return "a_" + Date.now() + "_" + Math.random().toString(36).slice(2, 9);
    }

    function createPresetAnswers(q) {
      const config = textboxConfig(q);
      return Array.from({ length: config.count }, (_, i) => ({
        id: cryptoRandomId(),
        text: "",
        images: [],
        width: "100%",
        height: 155,
        presetIndex: i,
        customLabel: ""
      }));
    }

    function ensureAnswers(index = currentIndex) {
      const key = questionKey(index);
      if (!Object.prototype.hasOwnProperty.call(answerState, key) || !Array.isArray(answerState[key])) {
        answerState[key] = createPresetAnswers(questions[index] || {});
      }

      // Chuẩn hóa dữ liệu cũ nếu có.
      answerState[key] = answerState[key].map((item, i) => ({
        id: item?.id || cryptoRandomId(),
        text: String(item?.text ?? ""),
        images: Array.isArray(item?.images) ? item.images.filter(x => typeof x === "string" && x.startsWith("data:image/")) : [],
        width: item?.width || "100%",
        height: Number(item?.height || 155),
        presetIndex: Number.isInteger(item?.presetIndex) ? item.presetIndex : (item?.customLabel ? null : i),
        customLabel: String(item?.customLabel ?? "")
      }));

      return answerState[key];
    }

    function answerLabel(item, visualIndex, q = questions[currentIndex] || {}) {
      const custom = normalize(item.customLabel);
      if (custom) return custom;

      const config = textboxConfig(q);
      if (Number.isInteger(item.presetIndex) && item.presetIndex >= 0) {
        const oneBased = item.presetIndex + 1;
        return config.names[oneBased] || config.labels[item.presetIndex] || `Ô văn bản ${oneBased}`;
      }
      return `Ô văn bản ${visualIndex + 1}`;
    }

    function nextUnusedApiTextboxIndex(q, list) {
      const config = textboxConfig(q);
      const used = new Set(list
        .filter(item => Number.isInteger(item.presetIndex) && item.presetIndex >= 0)
        .map(item => item.presetIndex));

      const available = Object.keys(config.names)
        .map(Number)
        .filter(oneBased => Number.isInteger(oneBased) && oneBased > 0 && normalize(config.names[oneBased]))
        .sort((a, b) => a - b);

      const nextOneBased = available.find(oneBased => !used.has(oneBased - 1));
      return nextOneBased ? nextOneBased - 1 : null;
    }

    function normalizeApiPayload(data) {
      if (typeof data === "string") {
        try { data = JSON.parse(data); }
        catch (_) {
          const preview = data.replace(/\s+/g, " ").trim().slice(0, 160);
          throw new Error("API không trả JSON hợp lệ" + (preview ? ": " + preview : "."));
        }
      }
      if (data && data.ok === false) throw new Error(data.error || "API báo lỗi.");
      const rawList = Array.isArray(data)
        ? data
        : Array.isArray(data?.data)
          ? data.data
          : Array.isArray(data?.items)
            ? data.items
            : [data];
      return rawList.filter(x => x && typeof x === "object" && !Array.isArray(x));
    }

    function showApiNotice(message, { retry = true } = {}) {
      const notice = document.createElement("div");
      notice.className = "api-notice";
      const text = document.createElement("span");
      text.textContent = message;
      notice.appendChild(text);
      if (retry) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "api-retry-btn";
        button.textContent = "Tải lại dữ liệu";
        button.addEventListener("click", () => loadQuestions({ force: true }));
        notice.appendChild(button);
      }
      els.questionArea.prepend(notice);
    }

    async function applyFreshQuestions(freshQuestions) {
      if (!freshQuestions.length) throw new Error("API không có dữ liệu phù hợp.");

      const newSignature = apiSignatureFor(freshQuestions);
      const previousSignature = await getStoredApiSignature();
      const apiChanged = !previousSignature || previousSignature !== newSignature;

      questions = freshQuestions;
      currentApiSignature = newSignature;

      if (apiChanged) {
        // API mới hoặc có thay đổi: xóa toàn bộ bài cũ nhưng tuyệt đối không xóa Họ tên + Lớp.
        await clearStoredProgress();
        answerState = {};
        currentIndex = 0;
        await setStoredApiSignature(newSignature);
      } else {
        // API hoàn toàn giống lần trước: khôi phục tiến trình của đúng Họ tên + Lớp.
        answerState = {};
        currentIndex = 0;
        await restoreProgressIfCompatible();
      }

      await setStoredApiData(freshQuestions);
      renderQuestionPicker();
      renderQuestion();
      renderAnswers();
    }

    async function loadQuestions({ force = false } = {}) {
      els.questionArea.innerHTML = '<div class="empty">Đang tải nhiệm vụ từ API…</div>';

      try {
        const response = await axiosRequestWithRetry({
          url: API_URL,
          method: "GET",
          params: force ? { fresh: 1 } : undefined,
          timeout: force ? 18000 : 14000
        }, { retries: force ? 2 : 3, baseDelay: 350 });

        const freshQuestions = normalizeApiPayload(response.data);
        await applyFreshQuestions(freshQuestions);

        const cacheHeader = String(response.headers?.["x-posttool-task-cache"] || "");
        const staleHeader = String(response.headers?.["x-posttool-task-stale"] || "");
        if (staleHeader === "1" || cacheHeader === "STALE") {
          showApiNotice("Kết nối Google Sheets đang chậm. Phiếu đang dùng bản dữ liệu máy chủ gần nhất và sẽ tự thử lại khi tải lại trang.");
        }
      } catch (error) {
        console.error("Không tải được API mới nhất:", error);

        // Không để 32 máy hiện trang trắng nếu Apps Script chậm trong vài giây.
        // Chỉ dùng bản API đã tải thành công trước đó trên chính thiết bị này.
        const cachedQuestions = await getStoredApiData();
        if (cachedQuestions.length) {
          questions = cachedQuestions;
          currentApiSignature = apiSignatureFor(cachedQuestions);
          answerState = {};
          currentIndex = 0;
          await restoreProgressIfCompatible();
          renderQuestionPicker();
          renderQuestion();
          renderAnswers();
          showApiNotice("Chưa lấy được dữ liệu mới nhất. Phiếu đang dùng dữ liệu đã tải thành công gần nhất trên máy này.");
          return;
        }

        questions = [];
        answerState = {};
        currentIndex = 0;
        currentApiSignature = "";
        els.answers.innerHTML = '<div class="answers-empty">Chưa tải được nhiệm vụ.</div>';
        els.questionArea.innerHTML = '';
        const box = document.createElement("div");
        box.className = "error";
        const strong = document.createElement("strong");
        strong.textContent = "Không tải được nhiệm vụ mới nhất từ API.";
        const detail = document.createElement("div");
        detail.style.marginTop = "6px";
        detail.textContent = axiosErrorMessage(error);
        const button = document.createElement("button");
        button.type = "button";
        button.className = "api-retry-btn";
        button.style.marginTop = "10px";
        button.textContent = "Thử tải lại";
        button.addEventListener("click", () => loadQuestions({ force: true }));
        box.append(strong, detail, button);
        els.questionArea.appendChild(box);
      }
    }

    function renderQuestionPicker() {
      if (questions.length <= 1) {
        els.questionPickerWrap.style.display = "none";
        return;
      }

      els.questionPickerWrap.style.display = "block";
      els.questionPicker.innerHTML = "";
      questions.forEach((q, i) => {
        const opt = document.createElement("option");
        opt.value = String(i);
        opt.textContent = displayTitle(q, i);
        if (i === currentIndex) opt.selected = true;
        els.questionPicker.appendChild(opt);
      });
    }

    function renderQuestion() {
      if (!questions.length) return;

      const q = questions[currentIndex];
      const title = displayTitle(q, currentIndex);
      const content = displayContent(q);
      const stt = displayStt(q, currentIndex);
      const sources = imageSources(q);

      els.questionArea.innerHTML = "";

      const head = document.createElement("div");
      const titleEl = document.createElement("h3");
      titleEl.className = "question-title";
      appendTextWithLinks(titleEl, title);
      head.appendChild(titleEl);
      els.questionArea.appendChild(head);

      if (content) {
        const contentEl = document.createElement("div");
        contentEl.className = "question-content";
        appendTextWithLinks(contentEl, content);
        els.questionArea.appendChild(contentEl);
      }

      // Hình ảnh luôn nằm ngay bên dưới phần Content để học sinh đọc tình huống trước.
      renderImageSources(els.questionArea, sources, q);
    }

    function renderImageCard(holder, source, index) {
      holder.innerHTML = "";
      const card = document.createElement("div");
      card.className = "image-card";

      const img = document.createElement("img");
      img.src = source.displayUrl || toDisplayImageUrl(source.originalUrl);
      img.alt = `Hình minh họa ${index + 1}`;
      img.loading = "eager";
      img.referrerPolicy = "no-referrer";
      img.addEventListener("error", () => card.classList.add("failed"));

      const fallback = document.createElement("div");
      fallback.className = "image-error";
      fallback.innerHTML = `Không tải được nội dung này.<br><a href="${escapeHtml(source.originalUrl)}" target="_blank" rel="noopener noreferrer">Mở đường dẫn</a>`;

      card.append(img, fallback);
      holder.appendChild(card);
    }

    function base64ToUint8Array(base64) {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      return bytes;
    }

    async function fetchPdfBytes(sourceUrl) {
      const data = await apiPost({ action: "resolvePdf", sourceUrl });
      if (!data?.base64) throw new Error("Apps Script không trả dữ liệu PDF.");
      const bytes = base64ToUint8Array(data.base64);
      if (!bytes.length) throw new Error("File PDF rỗng.");
      if (bytes.length > PDF_MAX_BYTES) throw new Error("File PDF quá lớn để hiển thị trong phiếu.");
      return bytes;
    }

    function renderPdfIframeFallback(stage, controls, source, message = "Đang dùng trình xem PDF dự phòng trên thiết bị này.") {
      controls.style.display = "none";
      const driveId = googleDriveFileId(source.originalUrl);
      const previewUrl = driveId
        ? `https://drive.google.com/file/d/${encodeURIComponent(driveId)}/preview`
        : source.originalUrl;
      stage.innerHTML = "";
      const iframe = document.createElement("iframe");
      iframe.className = "pdf-fallback-frame";
      iframe.src = previewUrl;
      iframe.title = "Tài liệu PDF";
      iframe.loading = "lazy";
      iframe.setAttribute("allow", "autoplay");
      stage.appendChild(iframe);
      const note = document.createElement("div");
      note.className = "pdf-fallback-note";
      note.textContent = message;
      stage.appendChild(note);
    }

    async function renderPdfViewer(holder, source) {
      holder.innerHTML = "";
      const card = document.createElement("div");
      card.className = "pdf-card";
      card.dataset.pdfSource = source.originalUrl;

      const stage = document.createElement("div");
      stage.className = "pdf-stage";
      const loading = document.createElement("div");
      loading.className = "pdf-loading";
      loading.textContent = "Đang tải PDF…";
      stage.appendChild(loading);

      const controls = document.createElement("div");
      controls.className = "pdf-controls";
      const prev = document.createElement("button");
      prev.type = "button";
      prev.className = "pdf-nav-btn";
      prev.textContent = "← Trang trước";
      const info = document.createElement("div");
      info.className = "pdf-page-info";
      info.textContent = "PDF";
      const next = document.createElement("button");
      next.type = "button";
      next.className = "pdf-nav-btn";
      next.textContent = "Trang sau →";
      controls.append(prev, info, next);

      const openRow = document.createElement("div");
      openRow.className = "pdf-open-row";
      openRow.innerHTML = `<a href="${escapeHtml(source.originalUrl)}" target="_blank" rel="noopener noreferrer">Mở PDF ở tab mới</a>`;

      card.append(stage, controls, openRow);
      holder.appendChild(card);

      if (Number(source.size || 0) > 3 * 1024 * 1024) {
        renderPdfIframeFallback(stage, controls, source, "PDF khá lớn nên đang dùng trình xem dự phòng để tránh lỗi dung lượng.");
        return;
      }

      try {
        if (!window.pdfjsLib) throw new Error("Thư viện PDF chưa tải được.");
        const bytes = await fetchPdfBytes(source.originalUrl);
        const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
        let pageNumber = 1;
        let rendering = false;
        let queuedPage = null;

        async function drawPage(number) {
          if (rendering) {
            queuedPage = number;
            return;
          }
          rendering = true;
          try {
            const page = await pdf.getPage(number);
            const base = page.getViewport({ scale: 1 });
            const targetWidth = Math.min(820, Math.max(480, holder.clientWidth ? holder.clientWidth - 40 : 760));
            const scale = Math.max(1, Math.min(2, targetWidth / base.width));
            const viewport = page.getViewport({ scale });
            const canvas = document.createElement("canvas");
            const ctx = canvas.getContext("2d", { alpha: false });
            canvas.width = Math.ceil(viewport.width);
            canvas.height = Math.ceil(viewport.height);
            stage.innerHTML = "";
            stage.appendChild(canvas);
            await page.render({ canvasContext: ctx, viewport }).promise;
            card.dataset.pdfPage = String(number);
            card.dataset.pdfPages = String(pdf.numPages);
            info.textContent = `Trang ${number} / ${pdf.numPages}`;
            prev.disabled = number <= 1;
            next.disabled = number >= pdf.numPages;
          } finally {
            rendering = false;
            if (queuedPage !== null && queuedPage !== number) {
              const qn = queuedPage;
              queuedPage = null;
              drawPage(qn);
            } else {
              queuedPage = null;
            }
          }
        }

        prev.addEventListener("click", () => {
          if (pageNumber <= 1) return;
          pageNumber -= 1;
          drawPage(pageNumber);
        });
        next.addEventListener("click", () => {
          if (pageNumber >= pdf.numPages) return;
          pageNumber += 1;
          drawPage(pageNumber);
        });

        mediaTypeCache.set(source.originalUrl, "pdf");
        await drawPage(1);
      } catch (error) {
        console.error("Không hiển thị được PDF bằng PDF.js:", error);
        renderPdfIframeFallback(stage, controls, source);
      }
    }

    async function resolveAmbiguousDriveFiles(q, holderMap, sourceMap) {
      const rawListImage = getListImageValue(q);
      try {
        const data = await apiPost({
          action: "resolveListItems",
          listImage: Array.isArray(rawListImage) ? JSON.stringify(rawListImage) : String(rawListImage ?? "")
        });
        const items = Array.isArray(data?.items) ? data.items : [];
        items.forEach(item => {
          const url = String(item?.sourceUrl || "");
          if (!url || !holderMap.has(url)) return;
          const source = sourceMap.get(url);
          if (!source) return;
          mediaTypeCache.set(url, item.type || "file");
          if (item.type === "pdf") {
            source.type = "pdf";
            source.size = Number(item.size || 0);
            renderPdfViewer(holderMap.get(url), source);
          }
        });
      } catch (error) {
        console.warn("Không xác định được loại file Drive trong List Image:", error);
      }
    }

    function renderImageSources(parent, sources, q) {
      const folders = sources.filter(x => x.type === "drive-folder");
      const media = sources.filter(x => x.type !== "drive-folder");

      if (media.length) {
        const gallery = document.createElement("div");
        gallery.className = "question-images";
        const holderMap = new Map();
        const sourceMap = new Map();

        media.forEach((source, i) => {
          const holder = document.createElement("div");
          holder.dataset.mediaSource = source.originalUrl;
          holderMap.set(source.originalUrl, holder);
          sourceMap.set(source.originalUrl, source);
          gallery.appendChild(holder);

          if (source.type === "pdf") renderPdfViewer(holder, source);
          else renderImageCard(holder, source, i);
        });

        parent.appendChild(gallery);
        if (media.some(x => x.type === "drive-file")) {
          resolveAmbiguousDriveFiles(q, holderMap, sourceMap);
        }
      }

      folders.forEach(source => {
        const wrap = document.createElement("div");
        wrap.className = "folder-card";

        const iframe = document.createElement("iframe");
        iframe.src = source.embedUrl;
        iframe.title = "Thư mục Google Drive";
        iframe.loading = "lazy";

        const note = document.createElement("div");
        note.className = "folder-note";
        note.innerHTML = `📁 Đang hiển thị thư mục Google Drive. <a href="${escapeHtml(source.originalUrl)}" target="_blank" rel="noopener noreferrer"><strong>Mở thư mục</strong></a>`;

        wrap.append(iframe, note);
        parent.appendChild(wrap);
      });
    }

    function captureCurrentBoxSizes() {
      if (!questions.length) return;
      const key = questionKey();
      const list = ensureAnswers();

      els.answers.querySelectorAll(".answer-editor[data-id]").forEach(editor => {
        const item = list.find(a => a.id === editor.dataset.id);
        if (!item) return;
        const rich = editor.querySelector(".answer-richtext");
        item.text = rich ? rich.innerText.replace(/\u00a0/g, " ") : item.text;
        item.width = editor.offsetWidth + "px";
        item.height = editor.offsetHeight;
      });

      answerState[key] = list;
    }

    function fitNameInput(input) {
      if (!input) return;
      const style = getComputedStyle(input);
      const canvas = fitNameInput.canvas || (fitNameInput.canvas = document.createElement("canvas"));
      const ctx = canvas.getContext("2d");
      ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const text = input.value || input.placeholder || "Ô văn bản";
      const measured = Math.ceil(ctx.measureText(text).width + 10);
      input.style.width = Math.max(58, Math.min(520, measured)) + "px";
    }

    async function localCompressImageFile(file, maxSide = 1400, quality = 0.80) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("Không đọc được ảnh."));
        reader.onload = () => {
          const img = new Image();
          img.onerror = () => reject(new Error("Ảnh không hợp lệ."));
          img.onload = () => {
            const scale = Math.min(1, maxSide / Math.max(img.width, img.height));
            const width = Math.max(1, Math.round(img.width * scale));
            const height = Math.max(1, Math.round(img.height * scale));
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext("2d");
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, width, height);
            ctx.drawImage(img, 0, 0, width, height);
            resolve(canvas.toDataURL("image/jpeg", quality));
          };
          img.src = reader.result;
        };
        reader.readAsDataURL(file);
      });
    }

    async function compressImageFile(file, maxSide = 1400, quality = 0.80) {
      // Large raw phone photos can exceed Vercel's request limit before Multer ever
      // sees them, so compress locally first on every device. This also makes
      // autosave/submit payloads much smaller and more reliable on mobile data.
      try {
        return await localCompressImageFile(file, Math.min(maxSide, 1400), Math.min(quality, 0.82));
      } catch (localError) {
        // HEIC/less common formats may fail in some browsers. For small enough files,
        // let Sharp on the server try to decode them as a compatibility fallback.
        if (Number(file?.size || 0) > 3.2 * 1024 * 1024) throw localError;
        const form = new FormData();
        form.append("image", file, file.name || "clipboard-image");
        form.append("maxSide", String(Math.min(maxSide, 1400)));
        form.append("quality", String(Math.min(quality, 0.82)));
        const response = await axiosRequestWithRetry({
          url: window.POSTTOOL_CONFIG?.imageUploadUrl || "/api/uploads/image",
          method: "POST",
          data: form,
          timeout: 30000
        }, { retries: 1, baseDelay: 400 });
        const result = response.data;
        if (!result?.ok || !String(result.dataUrl || "").startsWith("data:image/")) {
          throw new Error(result?.error || "Máy chủ không trả dữ liệu ảnh hợp lệ.");
        }
        return result.dataUrl;
      }
    }

    function expandEditorToFit(editor, item, { allowShrink = false } = {}) {
      if (!editor) return;
      requestAnimationFrame(() => {
        const previousHeight = Math.max(155, editor.offsetHeight || 155);
        editor.style.height = "auto";
        const requiredHeight = Math.max(155, editor.scrollHeight + 2);
        const nextHeight = allowShrink ? requiredHeight : Math.max(previousHeight, requiredHeight);
        editor.style.height = nextHeight + "px";
        if (item) item.height = nextHeight;
      });
    }

    function waitForImageDecode(img) {
      if (!img) return Promise.resolve();
      if (typeof img.decode === "function") {
        return img.decode().catch(() => undefined);
      }
      if (img.complete) return Promise.resolve();
      return new Promise(resolve => {
        img.addEventListener("load", resolve, { once: true });
        img.addEventListener("error", resolve, { once: true });
      });
    }


    function createCenteredExportImage(dataUrl, alt = "Hình ảnh") {
      const img = document.createElement("img");
      img.src = dataUrl;
      img.alt = alt;
      img.decoding = "async";
      img.loading = "eager";
      img.referrerPolicy = "no-referrer";
      return img;
    }

    async function dataUrlToCanvas(dataUrl, maxWidth = 920, maxHeight = 900) {
      const img = new Image();
      img.decoding = "async";
      img.src = dataUrl;
      await waitForImageDecode(img);
      if (!img.naturalWidth || !img.naturalHeight) throw new Error("Không đọc được ảnh đã dán.");

      const scale = Math.min(1, maxWidth / img.naturalWidth, maxHeight / img.naturalHeight);
      const width = Math.max(1, Math.round(img.naturalWidth * scale));
      const height = Math.max(1, Math.round(img.naturalHeight * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.setAttribute("aria-label", "Hình trong câu trả lời");
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      ctx.drawImage(img, 0, 0, width, height);
      return canvas;
    }

    function appendPastedImage(container, dataUrl, item, editor = null) {
      const wrap = document.createElement("div");
      wrap.className = "pasted-image-wrap";

      const img = document.createElement("img");
      img.src = dataUrl;
      img.alt = "Hình ảnh trong câu trả lời";
      img.decoding = "async";
      img.addEventListener("load", () => expandEditorToFit(editor, item), { once: true });

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "pasted-image-remove";
      remove.title = "Xóa ảnh";
      remove.setAttribute("aria-label", "Xóa ảnh");
      remove.textContent = "×";
      remove.addEventListener("click", () => {
        item.images = item.images.filter(x => x !== dataUrl);
        wrap.remove();
        expandEditorToFit(editor, item, { allowShrink: true });
        scheduleAutoSave();
      });

      wrap.append(img, remove);
      container.appendChild(wrap);
    }

    async function addImageFilesToAnswer(files, item, imageContainer, editor) {
      const imageFiles = [...files].filter(file => file && String(file.type).startsWith("image/"));
      if (!imageFiles.length) return;

      try {
        const dataUrls = await Promise.all(imageFiles.map(file => compressImageFile(file)));
        dataUrls.forEach(dataUrl => {
          item.images.push(dataUrl);
          appendPastedImage(imageContainer, dataUrl, item, editor);
        });
        expandEditorToFit(editor, item);
        scheduleAutoSave();
      } catch (error) {
        console.error(error);
        alert("Không thể dán ảnh này. Em hãy thử chụp hoặc sao chép lại ảnh rồi dán lần nữa.");
      }
    }

    function renderAnswers() {
      if (!questions.length) {
        els.answers.innerHTML = '<div class="answers-empty">Chưa có nhiệm vụ.</div>';
        return;
      }

      const q = questions[currentIndex];
      const list = ensureAnswers();
      const mode = layoutMode(q);

      els.answers.className = "answers layout-" + mode;
      els.answers.innerHTML = "";

      if (!list.length) {
        els.answers.innerHTML = '<div class="answers-empty">Nhiệm vụ này chưa tạo sẵn ô trả lời. Em có thể bấm <strong>＋ Thêm ô trả lời</strong> để bắt đầu.</div>';
        return;
      }

      list.forEach((item, index) => {
        const wrap = document.createElement("div");
        wrap.className = "answer-item";

        const top = document.createElement("div");
        top.className = "answer-top";

        const num = document.createElement("div");
        num.className = "answer-number";

        const indexBadge = document.createElement("span");
        indexBadge.className = "answer-index";
        indexBadge.textContent = String(index + 1);

        const nameInput = document.createElement("input");
        nameInput.type = "text";
        nameInput.className = "answer-name-input";
        nameInput.value = answerLabel(item, index, q);
        nameInput.setAttribute("aria-label", `Tên ô trả lời ${index + 1}`);
        nameInput.addEventListener("input", () => {
          item.customLabel = nameInput.value;
          fitNameInput(nameInput);
          rich.dataset.placeholder = `Viết ${answerLabel(item, index, q).toLocaleLowerCase("vi")} tại đây…`;
          scheduleAutoSave();
        });

        num.append(indexBadge, nameInput);

        const actions = document.createElement("div");
        actions.className = "answer-actions";

        const addImage = document.createElement("button");
        addImage.type = "button";
        addImage.className = "btn btn-secondary answer-image-button";
        addImage.style.minHeight = "34px";
        addImage.style.padding = "0 10px";
        addImage.textContent = "＋ Ảnh";
        addImage.title = "Thêm ảnh từ thiết bị";

        const fileInput = document.createElement("input");
        fileInput.type = "file";
        fileInput.accept = "image/*";
        fileInput.multiple = true;
        fileInput.hidden = true;
        addImage.addEventListener("click", () => fileInput.click());
        fileInput.addEventListener("change", async () => {
          const files = [...(fileInput.files || [])];
          fileInput.value = "";
          if (files.length) await addImageFilesToAnswer(files, item, imageContainer, editor);
        });

        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "btn btn-danger";
        remove.style.minHeight = "34px";
        remove.style.padding = "0 10px";
        remove.textContent = "Xóa";
        remove.addEventListener("click", () => removeAnswer(item.id));

        actions.append(addImage, remove, fileInput);
        top.append(num, actions);

        const editor = document.createElement("div");
        editor.className = "answer-editor";
        editor.dataset.id = item.id;
        if (item.width) editor.style.width = item.width;
        if (item.height) editor.style.height = Math.max(145, Number(item.height)) + "px";

        const rich = document.createElement("div");
        rich.className = "answer-richtext";
        rich.contentEditable = "true";
        rich.setAttribute("role", "textbox");
        rich.setAttribute("aria-multiline", "true");
        rich.dataset.placeholder = `Viết ${answerLabel(item, index, q).toLocaleLowerCase("vi")} tại đây…`;
        rich.textContent = item.text || "";
        rich.addEventListener("input", () => {
          item.text = rich.innerText.replace(/\u00a0/g, " ");
          expandEditorToFit(editor, item);
          scheduleAutoSave();
        });

        const imageContainer = document.createElement("div");
        imageContainer.className = "answer-pasted-images";
        item.images.forEach(dataUrl => appendPastedImage(imageContainer, dataUrl, item, editor));

        rich.addEventListener("paste", async event => {
          const files = [...(event.clipboardData?.items || [])]
            .filter(x => x.kind === "file" && String(x.type).startsWith("image/"))
            .map(x => x.getAsFile())
            .filter(Boolean);
          if (!files.length) return;
          event.preventDefault();
          await addImageFilesToAnswer(files, item, imageContainer, editor);
        });

        editor.addEventListener("dragover", event => {
          if ([...(event.dataTransfer?.items || [])].some(x => x.kind === "file" && String(x.type).startsWith("image/"))) {
            event.preventDefault();
          }
        });
        editor.addEventListener("drop", async event => {
          const files = [...(event.dataTransfer?.files || [])].filter(x => String(x.type).startsWith("image/"));
          if (!files.length) return;
          event.preventDefault();
          await addImageFilesToAnswer(files, item, imageContainer, editor);
        });

        editor.addEventListener("mouseup", scheduleAutoSave);
        editor.addEventListener("touchend", scheduleAutoSave);
        editor.append(rich, imageContainer);
        requestAnimationFrame(() => expandEditorToFit(editor, item));

        wrap.append(top, editor);
        els.answers.appendChild(wrap);
        fitNameInput(nameInput);
      });
    }

    function addAnswer() {
      if (!questions.length) return;
      captureCurrentBoxSizes();
      const list = ensureAnswers();
      const q = questions[currentIndex] || {};
      const nextPresetIndex = nextUnusedApiTextboxIndex(q, list);
      const nextNumber = list.length + 1;

      list.push({
        id: cryptoRandomId(),
        text: "",
        images: [],
        width: "100%",
        height: 155,
        presetIndex: nextPresetIndex,
        customLabel: nextPresetIndex === null ? `Ô văn bản ${nextNumber}` : ""
      });
      renderAnswers();
      scheduleAutoSave();
      setTimeout(() => {
        const items = els.answers.querySelectorAll(".answer-item");
        const lastItem = items[items.length - 1];
        lastItem?.querySelector(".answer-name-input")?.focus();
      }, 0);
    }

    function removeAnswer(id) {
      if (!questions.length) return;
      captureCurrentBoxSizes();
      const key = questionKey();
      const list = ensureAnswers();
      answerState[key] = list.filter(x => x.id !== id);
      renderAnswers();
      scheduleAutoSave();
    }


    function exportImagesHtml(sources) {
      if (!sources.length) return "";
      return `<div class="export-images" data-export-illustrations></div>`;
    }

    async function apiPost(payload) {
      try {
        const response = await axiosRequestWithRetry({
          url: API_URL,
          method: "POST",
          data: payload,
          timeout: 30000
        }, { retries: 2, baseDelay: 360 });
        const data = response.data;
        if (data && data.ok === false) throw new Error(data.error || "Apps Script báo lỗi.");
        return data;
      } catch (error) {
        throw new Error(axiosErrorMessage(error));
      }
    }

    function blobToDataUrl(blob) {
      return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error("Không đọc được dữ liệu ảnh."));
        reader.readAsDataURL(blob);
      });
    }

    async function directImageUrlToDataUrl(url) {
      const response = await axiosRequestWithRetry({
        url,
        method: "GET",
        responseType: "blob",
        timeout: 15000
      }, { retries: 1, baseDelay: 350 });
      const blob = response.data;
      if (!String(blob?.type || "").startsWith("image/")) throw new Error("URL không trả dữ liệu ảnh.");
      return blobToDataUrl(blob);
    }

    async function resolveIllustrationsForExport(q, sources) {
      if (!sources.length) return { images: [], warnings: [] };
      const rawListImage = getListImageValue(q);

      // Ưu tiên Apps Script: server có thể đọc Drive/website ngoài rồi trả base64,
      // tránh lỗi CORS khi html2canvas chụp ảnh minh họa.
      try {
        const data = await apiPost({
          action: "resolveIllustrations",
          listImage: Array.isArray(rawListImage) ? JSON.stringify(rawListImage) : String(rawListImage ?? "")
        });
        const images = Array.isArray(data?.images)
          ? data.images.filter(x => x && typeof x.dataUrl === "string" && x.dataUrl.startsWith("data:image/"))
          : [];
        if (images.length) return { images, warnings: Array.isArray(data?.warnings) ? data.warnings : [] };
      } catch (error) {
        console.warn("Không resolve ảnh qua Apps Script, thử trực tiếp:", error);
      }

      // Fallback cho URL có bật CORS. Folder Drive cần Apps Script mới đọc được file bên trong.
      const images = [];
      const warnings = [];
      for (const source of sources) {
        if (source.type !== "image") continue;
        try {
          const dataUrl = await directImageUrlToDataUrl(source.displayUrl);
          images.push({ dataUrl, sourceUrl: source.originalUrl });
        } catch (error) {
          console.warn("Không thể đọc ảnh minh họa trực tiếp:", source.originalUrl, error);
          warnings.push("Một hình minh họa bị máy chủ nguồn chặn khi xuất PNG.");
        }
      }
      return { images, warnings };
    }

    function collectCurrentPdfSnapshots() {
      const snapshots = new Map();
      document.querySelectorAll('.pdf-card[data-pdf-source]').forEach(card => {
        const sourceUrl = card.dataset.pdfSource || "";
        const canvas = card.querySelector('.pdf-stage canvas');
        if (!sourceUrl || !canvas || !canvas.width || !canvas.height) return;
        try {
          const maxWidth = 1000;
          let exportCanvas = canvas;
          if (canvas.width > maxWidth) {
            exportCanvas = document.createElement("canvas");
            exportCanvas.width = maxWidth;
            exportCanvas.height = Math.max(1, Math.round(canvas.height * (maxWidth / canvas.width)));
            const ctx = exportCanvas.getContext("2d", { alpha: false });
            ctx.fillStyle = "#ffffff";
            ctx.fillRect(0, 0, exportCanvas.width, exportCanvas.height);
            ctx.drawImage(canvas, 0, 0, exportCanvas.width, exportCanvas.height);
          }
          snapshots.set(sourceUrl, {
            dataUrl: exportCanvas.toDataURL('image/jpeg', 0.82),
            page: Number(card.dataset.pdfPage || 1),
            pages: Number(card.dataset.pdfPages || 1)
          });
        } catch (_) {}
      });
      return snapshots;
    }

    async function hydrateIllustrationsForExport(sheet, q, sources, pdfSnapshots = new Map()) {
      const slot = sheet.querySelector("[data-export-illustrations]");
      if (!slot) return;
      const resolved = await resolveIllustrationsForExport(q, sources);

      for (const item of resolved.images) {
        try {
          const frame = document.createElement("div");
          frame.className = "export-image-frame";
          const img = createCenteredExportImage(item.dataUrl, "Hình minh họa");
          frame.appendChild(img);
          slot.appendChild(frame);
        } catch (error) {
          console.warn("Không thể dựng một hình minh họa vào báo cáo:", error);
        }
      }
      let visualCount = resolved.images.length;
      sources.forEach(source => {
        const snap = pdfSnapshots.get(source.originalUrl);
        if (!snap?.dataUrl) return;
        try {
          const frame = document.createElement("div");
          frame.className = "export-image-frame";
          const img = createCenteredExportImage(snap.dataUrl, `PDF trang ${snap.page}`);
          frame.appendChild(img);
          slot.appendChild(frame);
          visualCount += 1;
        } catch (_) {}
      });
      if (visualCount === 1) slot.classList.add("single");

      [...new Set(resolved.warnings || [])].slice(0, 3).forEach(message => {
        const note = document.createElement("div");
        note.className = "image-export-note";
        note.textContent = message;
        slot.appendChild(note);
      });

      if (!slot.children.length) slot.remove();
    }

    async function waitForImages(root, timeoutMs = 7000) {
      const imgs = [...root.querySelectorAll("img")];
      if (!imgs.length) return;

      await Promise.race([
        Promise.all(imgs.map(img => waitForImageDecode(img))),
        new Promise(resolve => setTimeout(resolve, timeoutMs))
      ]);
    }

    function collectCurrentAnswerImagesFromDom() {
      const map = new Map();
      els.answers.querySelectorAll(".answer-editor[data-id]").forEach(editor => {
        const id = editor.dataset.id;
        if (!id) return;
        const urls = [...editor.querySelectorAll('.answer-pasted-images img')]
          .map(img => img.getAttribute('src') || '')
          .filter(src => typeof src === 'string' && src.startsWith('data:image/'));
        map.set(id, urls);
      });
      return map;
    }


    function mergedAnswerImages(answer, domImageMap = new Map()) {
      const stateImages = Array.isArray(answer?.images) ? answer.images : [];
      const domImages = answer?.id && domImageMap.has(answer.id) ? domImageMap.get(answer.id) : [];
      return [...new Set([...(stateImages || []), ...(domImages || [])])]
        .filter(dataUrl => typeof dataUrl === "string" && dataUrl.startsWith("data:image/"));
    }

    async function hydratePastedImagesForExport(sheet, list, domImageMap = new Map()) {
      const slots = [...sheet.querySelectorAll("[data-export-answer-images]")];
      for (const slot of slots) {
        const index = Number(slot.dataset.exportAnswerImages);
        const answer = list[index];
        const images = Array.isArray(answer?.images) ? answer.images : [];
        for (const dataUrl of images) {
          if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) continue;
          try {
            const canvas = await dataUrlToCanvas(dataUrl);
            slot.appendChild(canvas);
          } catch (error) {
            console.error("Không thể đưa ảnh paste vào báo cáo:", error);
            const fallback = document.createElement("div");
            fallback.textContent = "(Không đọc được một hình ảnh đã dán)";
            fallback.style.color = "#912018";
            fallback.style.fontSize = "13px";
            slot.appendChild(fallback);
          }
        }
      }
    }

    function safeFilePart(value) {
      return normalize(value)
        .replace(/[\\/:*?"<>|]+/g, "-")
        .replace(/\.+$/g, "")
        .trim()
        .slice(0, 100);
    }

    function reportBaseName(title) {
      const cls = safeFilePart(els.studentClass.value).toUpperCase().slice(0, 20);
      const name = safeFilePart(els.studentName.value).slice(0, 60);
      const lesson = safeFilePart(title || "Bài học").slice(0, 90);
      return `${cls}_${name}_${lesson}`;
    }

    function localSubmissionKey(baseName) {
      return "student_report_local_submission__" + baseName;
    }

    function peekLocalSubmissionNumber(baseName) {
      const current = Math.max(0, Number(safeLocalGet(localSubmissionKey(baseName)) || 0));
      return current + 1;
    }

    function commitLocalSubmissionNumber(baseName, number) {
      safeLocalSet(localSubmissionKey(baseName), String(Math.max(1, Number(number) || 1)));
    }

    function localReportFileName(baseName) {
      return `${baseName}_${peekLocalSubmissionNumber(baseName)}.png`;
    }

    function downloadReportCanvas(canvas, fileName) {
      const link = document.createElement("a");
      link.download = fileName;
      link.href = canvas.toDataURL("image/png");
      document.body.appendChild(link);
      link.click();
      link.remove();
    }

    async function uploadReportCanvas(canvas, folderUrl, baseName) {
      const imageData = canvas.toDataURL("image/png");
      return apiPost({
        action: "uploadReport",
        folderUrl,
        baseName,
        imageData
      });
    }

    function blobDownload(blob, fileName) {
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    }

    function responseHeader(response, name) {
      const headers = response?.headers || {};
      if (typeof headers.get === "function") return headers.get(name);
      return headers[String(name).toLowerCase()] || headers[name] || "";
    }

    function responseFileName(response, fallback) {
      const explicit = responseHeader(response, "X-Report-Filename");
      if (explicit) {
        try { return decodeURIComponent(explicit); } catch (_) { return explicit; }
      }
      return fallback;
    }

    async function resolveFallbackIllustrations(listImage) {
      const key = String(listImage || "").trim();
      if (!key) return [];
      if (illustrationResolveCache.has(key)) return illustrationResolveCache.get(key);

      const promise = (async () => {
        try {
          const response = await axiosRequestWithRetry({
            url: "/api/media/illustrations",
            method: "POST",
            data: { listImage: key },
            timeout: 35000
          }, { retries: 1, baseDelay: 420 });
          const data = response.data;
          return (Array.isArray(data?.images) ? data.images : [])
            .filter(item => String(item?.dataUrl || "").startsWith("data:image/"));
        } catch (error) {
          console.warn("Không lấy được ảnh minh họa qua server:", error);
          const fallback = [];
          for (const url of parseImageLinks(key).slice(0, 8)) {
            if (googleDriveFolderId(url) || looksLikePdfUrl(url)) continue;
            try {
              const dataUrl = await directImageUrlToDataUrl(toDisplayImageUrl(url));
              fallback.push({ dataUrl, sourceUrl: url });
            } catch (_) {}
          }
          return fallback;
        }
      })();

      illustrationResolveCache.set(key, promise);
      return promise;
    }

    function primeCurrentIllustrations() {
      if (!questions.length) return;
      const raw = getListImageValue(questions[currentIndex]);
      const key = Array.isArray(raw) ? JSON.stringify(raw) : String(raw ?? "");
      if (!key.trim()) return;
      void resolveFallbackIllustrations(key);
    }

    function canvasToBlob(canvas) {
      return new Promise((resolve, reject) => {
        try {
          if (canvas.toBlob) {
            canvas.toBlob(blob => {
              if (blob) resolve(blob);
              else reject(new Error("Không chuyển được canvas thành PNG."));
            }, "image/png");
            return;
          }
          const dataUrl = canvas.toDataURL("image/png");
          fetch(dataUrl).then(r => r.blob()).then(resolve, reject);
        } catch (error) { reject(error); }
      });
    }

    async function pngBlobWithinLimit(canvas, maxBytes = 3.35 * 1024 * 1024) {
      let current = canvas;
      let blob = await canvasToBlob(current);
      let attempts = 0;
      while (blob.size > maxBytes && current.width > 720 && attempts < 5) {
        attempts += 1;
        const scale = 0.84;
        const next = document.createElement("canvas");
        next.width = Math.max(720, Math.round(current.width * scale));
        next.height = Math.max(1, Math.round(current.height * (next.width / current.width)));
        const ctx = next.getContext("2d", { alpha: false });
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, next.width, next.height);
        ctx.drawImage(current, 0, 0, next.width, next.height);
        current = next;
        blob = await canvasToBlob(current);
      }
      return blob;
    }

    async function buildClientFallbackReportBlob(payload) {
      if (typeof window.html2canvas !== "function") {
        throw new Error("Thư viện tạo ảnh dự phòng chưa tải được.");
      }

      const serverVisuals = await resolveFallbackIllustrations(payload.listImage);
      const visuals = [
        ...serverVisuals.map((item, index) => ({ dataUrl: item.dataUrl, alt: `Hình minh họa ${index + 1}`, caption: "" })),
        ...(Array.isArray(payload.illustrations) ? payload.illustrations : [])
      ].filter(item => String(item?.dataUrl || "").startsWith("data:image/"));

      const sheet = document.createElement("div");
      sheet.className = "export-sheet";
      sheet.style.position = "fixed";
      sheet.style.left = "-12000px";
      sheet.style.top = "0";
      sheet.style.zIndex = "-1";

      const visualsHtml = visuals.length
        ? `<div class="export-images ${visuals.length === 1 ? "single" : ""}">`
          + visuals.map(item => `<div class="export-image-frame"><img src="${escapeHtml(item.dataUrl)}" alt="${escapeHtml(item.alt || "Hình minh họa")}">${item.caption ? `<div class="export-image-caption">${escapeHtml(item.caption)}</div>` : ""}</div>`).join("")
          + `</div>`
        : "";

      const answersHtml = (payload.answers || []).length
        ? payload.answers.map(answer => {
            const images = Array.isArray(answer.images) ? answer.images.filter(src => String(src).startsWith("data:image/")) : [];
            const imagesHtml = images.length
              ? `<div class="export-answer-images ${images.length === 1 ? "single" : ""}">`
                + images.map(src => `<div class="export-answer-image-frame"><img src="${escapeHtml(src)}" alt="Hình ảnh trong bài làm"></div>`).join("")
                + `</div>`
              : "";
            const textHtml = String(answer.text || "").trim()
              ? `<div>${escapeHtml(answer.text)}</div>`
              : (!images.length ? `<div>(Chưa có nội dung)</div>` : "");
            return `<div class="export-answer"><span class="label">${escapeHtml(answer.label || "Ô trả lời")}</span>${textHtml}${imagesHtml}</div>`;
          }).join("")
        : `<div class="export-answer"><span class="label">Bài làm</span>(Chưa có ô trả lời)</div>`;

      sheet.innerHTML = `
        <div class="export-banner"><h2>Phiếu trả lời</h2><p>Bài làm của học sinh</p></div>
        <div class="export-student">
          <div class="export-info"><small>HỌ VÀ TÊN</small>${escapeHtml(payload.studentName)}</div>
          <div class="export-info"><small>LỚP</small>${escapeHtml(payload.studentClass)}</div>
        </div>
        <div class="export-q">
          <h3>${escapeHtml(payload.title)}</h3>
          ${payload.content ? `<div class="content">${escapeHtml(payload.content)}</div>` : ""}
          ${visualsHtml}
        </div>
        <div class="export-answers"><h3>Bài làm</h3><div class="export-answer-list layout-${escapeHtml(payload.layout || "vertical")}">${answersHtml}</div></div>`;

      document.body.appendChild(sheet);
      try {
        await waitForImages(sheet, 12000);
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const h = Math.max(1, sheet.scrollHeight);
        const scale = Math.min(1.25, Math.max(0.45, 12000 / h));
        const canvas = await html2canvas(sheet, {
          scale,
          backgroundColor: "#ffffff",
          useCORS: true,
          allowTaint: false,
          logging: false,
          imageTimeout: 10000,
          windowWidth: 1200,
          width: sheet.scrollWidth,
          height: sheet.scrollHeight,
          scrollX: 0,
          scrollY: 0
        });
        return await pngBlobWithinLimit(canvas);
      } finally {
        sheet.remove();
      }
    }

    async function checkSubmissionStatus(folderUrl, baseName, submissionId) {
      if (!folderUrl || !submissionId) return null;
      const response = await axiosRequestWithRetry({
        url: window.POSTTOOL_CONFIG?.reportStatusUrl || "/api/reports/status",
        method: "POST",
        data: { folderUrl, baseName, submissionId },
        timeout: 22000
      }, { retries: 1, baseDelay: 500 });
      const data = response.data || {};
      if (data?.ok === false) throw new Error(data?.error || "Không kiểm tra được trạng thái bài nộp.");
      return data;
    }

    async function uploadFallbackReportBlob(blob, folderUrl, baseName, submissionId = "", localAttempt = 1) {
      const form = new FormData();
      form.append("report", blob, `${baseName}.png`);
      form.append("folderUrl", folderUrl);
      form.append("baseName", baseName);
      form.append("submissionId", submissionId);
      form.append("localAttempt", String(Math.max(1, Number(localAttempt) || 1)));
      const response = await axiosRequestWithRetry({
        url: window.POSTTOOL_CONFIG?.reportFallbackUploadUrl || "/api/reports/upload",
        method: "POST",
        data: form,
        timeout: 70000
      }, { retries: 0 });
      const data = response.data || {};
      if (data?.ok === false) throw new Error(data?.error || "Không tải được bài nộp.");
      return data;
    }

    async function submitWithClientFallback(payload, localAttempt, serverReason = "") {
      els.exportBtn.textContent = "Đang tạo bài nộp trên thiết bị…";
      const blob = await buildClientFallbackReportBlob(payload);
      const fileName = `${payload.baseName}_${localAttempt}.png`;

      if (payload.folderUrl) {
        try {
          els.exportBtn.textContent = "Đang tải bài lên Drive…";
          const result = await uploadFallbackReportBlob(blob, payload.folderUrl, payload.baseName, payload.submissionId, localAttempt);
          alert(`Đã nộp bài lên Google Drive:\n${result.fileName || "Bài nộp đã được lưu"}`);
          return true;
        } catch (uploadError) {
          console.error("Upload fallback thất bại:", uploadError);
          blobDownload(blob, fileName);
          commitLocalSubmissionNumber(payload.baseName, localAttempt);
          alert("Máy chủ không tải được bài lên Google Drive. Hệ thống đã tạo và tải file PNG về thiết bị để tránh mất bài.");
          return true;
        }
      }

      blobDownload(blob, fileName);
      commitLocalSubmissionNumber(payload.baseName, localAttempt);
      if (serverReason) console.warn("Đã dùng renderer dự phòng:", serverReason);
      return true;
    }

    async function buildReportIllustrations(q, sources) {
      // Normal List Image files are resolved by the Node server through Apps Script.
      // The client only needs to send the currently visible PDF page snapshot.
      const visuals = [];
      const pdfSnapshots = collectCurrentPdfSnapshots();
      sources.forEach(source => {
        const snap = pdfSnapshots.get(source.originalUrl);
        if (!snap?.dataUrl) return;
        visuals.push({
          dataUrl: snap.dataUrl,
          alt: `PDF trang ${snap.page}`,
          caption: `Trang ${snap.page} / ${snap.pages}`
        });
      });
      return visuals;
    }

    async function submitViaServerRenderer(payload, localAttempt) {
      const payloadJson = JSON.stringify(payload);
      const payloadBytes = typeof Blob !== "undefined" ? new Blob([payloadJson]).size : payloadJson.length;
      const maxRequestBytes = Number(window.POSTTOOL_CONFIG?.maxReportRequestBytes || 3.55 * 1024 * 1024);
      if (payloadBytes > maxRequestBytes) {
        throw new Error("Bài làm quá lớn để chuyển sang renderer máy chủ.");
      }

      els.exportBtn.textContent = payload.folderUrl ? "Đang thử máy chủ dự phòng…" : "Đang tạo báo cáo…";
      const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), 70000) : null;
      let response;
      try {
        response = await axiosRequestWithRetry({
          url: window.POSTTOOL_CONFIG?.reportSubmitUrl || "/api/reports/submit",
          method: "POST",
          data: payload,
          responseType: "blob",
          timeout: 70000,
          signal: controller?.signal
        }, { retries: 0 });
      } finally {
        if (timer) clearTimeout(timer);
      }

      const contentType = String(responseHeader(response, "content-type") || "");
      if (contentType.includes("image/png")) {
        const blob = response.data;
        const fallbackName = `${payload.baseName}_${localAttempt}.png`;
        const fileName = responseFileName(response, fallbackName);
        blobDownload(blob, fileName);
        commitLocalSubmissionNumber(payload.baseName, localAttempt);
        if (responseHeader(response, "X-Posttool-Upload-Fallback") === "1") {
          alert("Không xác nhận được việc tải lên Google Drive. Hệ thống đã tải bản PNG về thiết bị để tránh mất bài.");
        }
        return true;
      }

      let result = {};
      try {
        const raw = response.data instanceof Blob ? await response.data.text() : String(response.data || "");
        result = raw ? JSON.parse(raw) : {};
      } catch (_) {}
      if (result?.ok === false) {
        const detail = result?.detail ? `
Chi tiết kỹ thuật: ${result.detail}` : "";
        throw new Error((result?.error || "Máy chủ không tạo được báo cáo.") + detail);
      }
      if (result.mode === "drive") {
        alert(`Đã nộp bài lên Google Drive:\n${result.fileName || "Bài nộp đã được lưu"}`);
      }
      return true;
    }

    async function exportPNG() {
      if (submissionInFlight) return;
      if (!questions.length) {
        alert("Chưa có nhiệm vụ để nộp bài.");
        return;
      }
      if (!normalize(els.studentName.value) || !normalize(els.studentClass.value)) {
        alert("Em hãy nhập đầy đủ Họ và tên và Lớp trước khi nộp bài.");
        return;
      }

      submissionInFlight = true;
      captureCurrentBoxSizes();
      saveProgress({ silent: true });
      els.exportBtn.disabled = true;
      els.exportBtn.textContent = "Đang chuẩn bị bài nộp…";

      try {
        const q = questions[currentIndex];
        const list = ensureAnswers();
        const domImageMap = collectCurrentAnswerImagesFromDom();
        const title = displayTitle(q, currentIndex);
        const content = displayContent(q);
        const sources = imageSources(q);
        const mode = layoutMode(q);
        const folderUrl = getFolderValue(q);
        const baseName = reportBaseName(title);
        const illustrations = await buildReportIllustrations(q, sources);
        const rawListImage = getListImageValue(q);
        const localAttempt = peekLocalSubmissionNumber(baseName);
        const submissionId = createSubmissionId();

        const answers = list.map((answer, index) => ({
          label: answerLabel(answer, index, q),
          text: String(answer.text || ""),
          images: mergedAnswerImages(answer, domImageMap)
        }));

        const payload = {
          submissionId,
          studentName: normalize(els.studentName.value),
          studentClass: normalize(els.studentClass.value).toUpperCase(),
          title,
          content,
          layout: mode,
          folderUrl,
          listImage: Array.isArray(rawListImage) ? JSON.stringify(rawListImage) : String(rawListImage ?? ""),
          baseName,
          localAttempt,
          answers,
          illustrations
        };

        const strategy = String(window.POSTTOOL_CONFIG?.reportStrategy || "client-first").toLowerCase();
        let clientError = null;

        // FAST PATH: giống bản web tĩnh - dựng PNG ngay trên thiết bị rồi chỉ upload
        // một file đã nén. Không khởi động Chromium nếu không cần thiết.
        if (strategy !== "server-first") {
          try {
            els.exportBtn.textContent = "Đang tạo ảnh bài làm…";
            const blob = await buildClientFallbackReportBlob(payload);
            if (folderUrl) {
              els.exportBtn.textContent = "Đang tải bài lên Drive…";
              const result = await uploadFallbackReportBlob(blob, folderUrl, baseName, submissionId, localAttempt);
              alert(`Đã nộp bài lên Google Drive:\n${result.fileName || "Bài nộp đã được lưu"}`);
            } else {
              const fileName = `${baseName}_${localAttempt}.png`;
              blobDownload(blob, fileName);
              commitLocalSubmissionNumber(baseName, localAttempt);
            }
            return;
          } catch (error) {
            clientError = error;
            console.warn("Fast path gặp lỗi, kiểm tra xem Drive đã nhận file chưa:", error);
            if (folderUrl) {
              try {
                els.exportBtn.textContent = "Đang xác nhận bài đã nộp…";
                const status = await checkSubmissionStatus(folderUrl, baseName, submissionId);
                if (status?.found && status?.fileId) {
                  alert(`Đã nộp bài lên Google Drive:
${status.fileName || "Bài nộp đã được lưu"}`);
                  return;
                }
              } catch (statusError) {
                console.warn("Không xác nhận được trạng thái bài nộp:", statusError);
              }
            }
            console.warn("Chuyển sang renderer máy chủ dự phòng.");
          }
        }

        // FALLBACK: chỉ dùng Puppeteer/Chromium nếu thiết bị không dựng/upload được.
        try {
          await submitViaServerRenderer(payload, localAttempt);
          return;
        } catch (serverError) {
          console.error("Server renderer thất bại:", serverError);
          const reason = [clientError?.message, serverError?.message].filter(Boolean).join(" | ");
          throw new Error(reason || "Không thể nộp bài.");
        }
      } catch (error) {
        console.error(error);
        alert("Không thể nộp bài. Bài làm vẫn đang được giữ trên thiết bị.\n" + (error?.message || ""));
      } finally {
        submissionInFlight = false;
        els.exportBtn.disabled = false;
        els.exportBtn.textContent = "📤 Nộp bài";
      }
    }

    function safeJSON(text) {
      if (!text) return null;
      try { return JSON.parse(text); } catch (_) { return null; }
    }

    function escapeHtml(value) {
      return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
    }

    els.addAnswerBtn.addEventListener("click", addAnswer);
    els.exportBtn.addEventListener("click", exportPNG);

    els.questionPicker.addEventListener("change", () => {
      captureCurrentBoxSizes();
      currentIndex = Number(els.questionPicker.value || 0);
      renderQuestion();
      renderAnswers();
      scheduleAutoSave();
    });

    [els.studentName, els.studentClass].forEach(input => {
      input.addEventListener("input", () => {
        scheduleIdentitySave();
        scheduleAutoSave();
      });
      input.addEventListener("change", () => {
        saveIdentity();
        saveProgress({ silent: true });
      });
    });

    function persistBeforeLeaving() {
      saveIdentity();
      saveProgress({ silent: true });
    }

    window.addEventListener("beforeunload", persistBeforeLeaving);
    window.addEventListener("pagehide", persistBeforeLeaving);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") persistBeforeLeaving();
    });

    (async function init() {
      restoreIdentity();
      // Khi NetSupport mở đồng loạt nhiều máy, giãn request vài trăm ms để
      // tránh toàn bộ thiết bị chạm server ở cùng một mili-giây.
      const jitterMax = Math.max(0, Number(window.POSTTOOL_CONFIG?.startupJitterMs || 350));
      if (jitterMax > 0) await sleepClient(Math.floor(Math.random() * jitterMax));
      await loadQuestions();
    })();
