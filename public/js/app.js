// Nếu thầy đổi endpoint, chỉ cần thay URL tại đây.
    const API_URL = window.POSTTOOL_CONFIG?.apiUrl || "/api/task";

    if (window.pdfjsLib) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = window.POSTTOOL_CONFIG?.pdfWorkerUrl || "/vendor/pdfjs/pdf.worker.min.js";
    }
    const PDF_MAX_BYTES = 18 * 1024 * 1024;
    const mediaTypeCache = new Map();


    // Luôn tải API mới khi reload. Nếu API không đổi thì khôi phục tiến trình;
    // nếu API thay đổi thì reset bài làm và chỉ giữ Họ tên + Lớp.
    const LAST_ID_KEY = "student_reflection_last_identity_v5";
    const API_SIGNATURE_KEY = "student_reflection_api_signature_v1";
    const PROGRESS_PREFIX = "student_reflection_progress_v6__";

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

    function normalize(s) {
      return String(s ?? "").trim().replace(/\s+/g, " ");
    }

    function safeNumber(value, fallback = 0) {
      const n = Number.parseInt(String(value ?? "").trim(), 10);
      return Number.isFinite(n) ? n : fallback;
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
        localStorage.setItem(LAST_ID_KEY, JSON.stringify({ studentName, studentClass }));
      } catch (error) {
        console.warn("Không thể lưu Họ tên + Lớp trên trình duyệt:", error);
      }
    }

    function scheduleIdentitySave() {
      clearTimeout(identitySaveTimer);
      identitySaveTimer = setTimeout(saveIdentity, 300);
    }

    function restoreIdentity() {
      const last = safeJSON(localStorage.getItem(LAST_ID_KEY))
        || safeJSON(localStorage.getItem("student_reflection_last_identity_v4"))
        || safeJSON(localStorage.getItem("student_reflection_last_identity_v3"));
      if (!last) return;
      els.studentName.value = String(last.studentName || "");
      els.studentClass.value = String(last.studentClass || "");
      saveIdentity();
    }

    function clearStoredProgress() {
      const keysToRemove = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i) || "";
        if (key.startsWith(PROGRESS_PREFIX)
            || key.startsWith("student_reflection_progress_v3__")
            || key.startsWith("student_reflection_progress_v4__")
            || key.startsWith("student_reflection_progress_v5__")) {
          keysToRemove.push(key);
        }
      }
      keysToRemove.forEach(key => localStorage.removeItem(key));
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
      try {
        localStorage.setItem(key, JSON.stringify(data));
        saveIdentity();
        return true;
      } catch (error) {
        console.warn("Không thể tự lưu tiến trình:", error);
        if (!silent) alert("Không thể lưu tiến trình trên trình duyệt này. Có thể dữ liệu ảnh đã vượt dung lượng lưu trữ.");
        return false;
      }
    }

    function scheduleAutoSave() {
      clearTimeout(autoSaveTimer);
      autoSaveTimer = setTimeout(() => saveProgress({ silent: true }), 2500);
    }

    function restoreProgressIfCompatible() {
      const key = progressKey();
      if (!key) return false;
      const data = safeJSON(localStorage.getItem(key));
      if (!data || data.apiSignature !== currentApiSignature) return false;

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

    async function loadQuestions() {
      els.questionArea.innerHTML = '<div class="empty">Đang tải nhiệm vụ từ API…</div>';

      try {
        // GIỮ REQUEST Ở DẠNG "SIMPLE GET" ĐỂ TƯƠNG THÍCH GOOGLE APPS SCRIPT.
        // Không thêm Cache-Control/custom header vì sẽ có thể kích hoạt CORS preflight
        // và dẫn tới lỗi "Failed to fetch". Tham số _ts đảm nhiệm việc chống cache.
        const requestUrl = API_URL + (API_URL.includes("?") ? "&" : "?") + "_ts=" + Date.now();
        const response = await fetch(requestUrl, {
          method: "GET",
          redirect: "follow"
        });
        if (!response.ok) throw new Error("HTTP " + response.status);

        // Đọc text trước để báo lỗi rõ hơn nếu deployment trả HTML/login page
        // thay vì JSON hợp lệ.
        const rawText = await response.text();
        let data;
        try {
          data = JSON.parse(rawText);
        } catch (_) {
          const preview = rawText.replace(/\s+/g, " ").trim().slice(0, 160);
          throw new Error("API không trả JSON hợp lệ" + (preview ? ": " + preview : "."));
        }
        if (data && data.ok === false) throw new Error(data.error || "API báo lỗi.");

        const rawList = Array.isArray(data)
          ? data
          : Array.isArray(data?.data)
            ? data.data
            : Array.isArray(data?.items)
              ? data.items
              : [data];

        const freshQuestions = rawList.filter(x => x && typeof x === "object" && !Array.isArray(x));
        if (!freshQuestions.length) throw new Error("API không có dữ liệu phù hợp.");

        const newSignature = apiSignatureFor(freshQuestions);
        const previousSignature = localStorage.getItem(API_SIGNATURE_KEY) || "";
        const apiChanged = !previousSignature || previousSignature !== newSignature;

        questions = freshQuestions;
        currentApiSignature = newSignature;

        if (apiChanged) {
          // API mới hoặc có thay đổi: xóa toàn bộ bài cũ nhưng tuyệt đối không xóa Họ tên + Lớp.
          clearStoredProgress();
          answerState = {};
          currentIndex = 0;
          localStorage.setItem(API_SIGNATURE_KEY, newSignature);
        } else {
          // API hoàn toàn giống lần trước: khôi phục tiến trình của đúng Họ tên + Lớp.
          answerState = {};
          currentIndex = 0;
          restoreProgressIfCompatible();
        }

        renderQuestionPicker();
        renderQuestion();
        renderAnswers();
      } catch (error) {
        // Nếu API lỗi, không đổi signature và không xóa tiến trình đang lưu.
        questions = [];
        answerState = {};
        currentIndex = 0;
        currentApiSignature = "";
        els.answers.innerHTML = '<div class="answers-empty">Chưa tải được nhiệm vụ.</div>';
        els.questionArea.innerHTML = '<div class="error"><strong>Không tải được nhiệm vụ mới nhất từ API.</strong><br>Hãy kiểm tra endpoint Apps Script rồi tải lại trang.<br><small>' + escapeHtml(error.message) + '</small></div>';
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
      head.innerHTML = `
        <h3 class="question-title">${escapeHtml(title)}</h3>
      `;
      els.questionArea.appendChild(head);

      if (content) {
        const contentEl = document.createElement("div");
        contentEl.className = "question-content";
        contentEl.textContent = content;
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
        console.error("Không hiển thị được PDF:", error);
        stage.innerHTML = `<div class="pdf-error">Không hiển thị được PDF trong phiếu.<br>${escapeHtml(error.message || String(error))}</div>`;
        controls.style.display = "none";
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

    async function localCompressImageFile(file, maxSide = 1600, quality = 0.86) {
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

    async function compressImageFile(file, maxSide = 1800, quality = 0.88) {
      try {
        const form = new FormData();
        form.append("image", file, file.name || "clipboard-image.png");
        form.append("maxSide", String(maxSide));
        form.append("quality", String(quality));
        const response = await fetch(window.POSTTOOL_CONFIG?.imageUploadUrl || "/api/uploads/image", {
          method: "POST",
          body: form,
          cache: "no-store"
        });
        if (!response.ok) throw new Error("HTTP " + response.status);
        const result = await response.json();
        if (!result?.ok || !String(result.dataUrl || "").startsWith("data:image/")) {
          throw new Error(result?.error || "Máy chủ không trả dữ liệu ảnh hợp lệ.");
        }
        return result.dataUrl;
      } catch (error) {
        console.warn("Không xử lý được ảnh qua server, dùng xử lý tại trình duyệt:", error);
        return localCompressImageFile(file, Math.min(maxSide, 1600), quality);
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

        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "btn btn-danger";
        remove.style.minHeight = "34px";
        remove.style.padding = "0 10px";
        remove.textContent = "Xóa";
        remove.addEventListener("click", () => removeAnswer(item.id));

        actions.appendChild(remove);
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
      const response = await fetch(API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        cache: "no-store",
        redirect: "follow"
      });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); }
      catch (_) { throw new Error("Apps Script không trả JSON hợp lệ."); }
      if (data && data.ok === false) throw new Error(data.error || "Apps Script báo lỗi.");
      return data;
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
      const response = await fetch(url, { mode: "cors", cache: "no-store", redirect: "follow" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const blob = await response.blob();
      if (!String(blob.type || "").startsWith("image/")) throw new Error("URL không trả dữ liệu ảnh.");
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
          snapshots.set(sourceUrl, {
            dataUrl: canvas.toDataURL('image/png'),
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
        .trim();
    }

    function reportBaseName(title) {
      const cls = safeFilePart(els.studentClass.value).toUpperCase();
      const name = safeFilePart(els.studentName.value);
      const lesson = safeFilePart(title || "Bài học");
      return `${cls}_${name}_${lesson}`;
    }

    function nextLocalSubmissionNumber(baseName) {
      const key = "student_report_local_submission__" + baseName;
      const current = Math.max(0, Number(localStorage.getItem(key) || 0));
      const next = current + 1;
      localStorage.setItem(key, String(next));
      return next;
    }

    function localReportFileName(baseName) {
      return `${baseName}_${nextLocalSubmissionNumber(baseName)}.png`;
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

    function responseFileName(response, fallback) {
      const explicit = response.headers.get("X-Report-Filename");
      if (explicit) {
        try { return decodeURIComponent(explicit); } catch (_) { return explicit; }
      }
      return fallback;
    }

    async function buildReportIllustrations(q, sources) {
      const visuals = [];
      const resolved = await resolveIllustrationsForExport(q, sources);
      (resolved.images || []).forEach((item, index) => {
        if (String(item?.dataUrl || "").startsWith("data:image/")) {
          visuals.push({ dataUrl: item.dataUrl, alt: `Hình minh họa ${index + 1}` });
        }
      });

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

    async function exportPNG() {
      if (!questions.length) {
        alert("Chưa có nhiệm vụ để nộp bài.");
        return;
      }

      if (!normalize(els.studentName.value) || !normalize(els.studentClass.value)) {
        alert("Em hãy nhập đầy đủ Họ và tên và Lớp trước khi nộp bài.");
        return;
      }

      captureCurrentBoxSizes();
      saveProgress({ silent: true });
      els.exportBtn.disabled = true;
      els.exportBtn.textContent = "Đang tạo bài nộp…";

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

        const answers = list.map((answer, index) => ({
          label: answerLabel(answer, index, q),
          text: String(answer.text || ""),
          images: mergedAnswerImages(answer, domImageMap)
        }));

        const localAttempt = folderUrl ? null : nextLocalSubmissionNumber(baseName);
        const payload = {
          studentName: normalize(els.studentName.value),
          studentClass: normalize(els.studentClass.value).toUpperCase(),
          title,
          content,
          layout: mode,
          folderUrl,
          baseName,
          localAttempt,
          answers,
          illustrations
        };

        els.exportBtn.textContent = folderUrl ? "Đang nộp bài…" : "Đang tạo báo cáo…";
        const response = await fetch(window.POSTTOOL_CONFIG?.reportSubmitUrl || "/api/reports/submit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          cache: "no-store"
        });

        const contentType = response.headers.get("content-type") || "";
        if (contentType.includes("image/png")) {
          if (!response.ok) throw new Error("HTTP " + response.status);
          const blob = await response.blob();
          const fallback = `${baseName}_${localAttempt || 1}.png`;
          const fileName = responseFileName(response, fallback);
          blobDownload(blob, fileName);
          if (response.headers.get("X-Posttool-Upload-Fallback") === "1") {
            alert("Không tải được bài lên Google Drive. Hệ thống đã tải bản PNG về máy để tránh mất bài.");
          }
          return;
        }

        const result = await response.json().catch(() => ({}));
        if (!response.ok || result?.ok === false) {
          throw new Error(result?.error || `HTTP ${response.status}`);
        }

        if (result.mode === "drive") {
          alert(`Đã nộp bài lên Google Drive:\n${result.fileName || "Bài nộp đã được lưu"}`);
        } else {
          alert("Đã tạo báo cáo thành công.");
        }
      } catch (error) {
        console.error(error);
        alert("Không thể nộp bài. Hãy thử lại hoặc báo cho thầy cô kiểm tra hệ thống.\n" + (error?.message || ""));
      } finally {
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

    window.addEventListener("beforeunload", () => {
      saveIdentity();
      saveProgress({ silent: true });
    });

    (async function init() {
      restoreIdentity();
      await loadQuestions();
    })();
