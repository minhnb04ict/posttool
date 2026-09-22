/**
 * GOOGLE APPS SCRIPT - POSTTOOL 1.3.3
 *
 * Chuc nang:
 * 1) GET /exec -> tra du lieu Google Sheet dang JSON. Ho tro ca 2 kieu:
 *    - Key/Value theo chieu doc: cot A = ten truong, cot B = gia tri (khuyen dung cho phieu nay).
 *    - Bang ngang: dong 1 = header, cac dong sau = du lieu.
 * 2) POST action=resolveIllustrations -> doc anh List Image bang quyen cua script
 *    va tra data:image/...;base64 de web co the dua anh vao bao cao PNG, tranh loi CORS.
 * 3) POST action=uploadReport -> luu PNG vao Folder, co submissionId chong nop trung.
 * 4) POST action=findSubmission -> kiem tra lan nop da duoc tao hay chua sau timeout/mat response.
 *
 * Neu script nay duoc tao truc tiep tu Google Sheet (Extensions > Apps Script),
 * co the de SPREADSHEET_ID = "".
 * Neu la standalone Apps Script, dien Spreadsheet ID vao SPREADSHEET_ID.
 */

const CONFIG = {
  SPREADSHEET_ID: "",       // De trong neu Apps Script bound voi Google Sheet.
  SHEET_NAME: "",           // De trong = lay sheet dau tien.
  MAX_ILLUSTRATIONS: 12,     // Gioi han anh minh hoa tra ve moi lan.
  MAX_IMAGE_BYTES: 8 * 1024 * 1024,
  MAX_REPORT_BYTES: 25 * 1024 * 1024,
  MAX_PDF_BYTES: 3 * 1024 * 1024,
  TASK_CACHE_SECONDS: 2
};

function doGet(e) {
  try {
    const params = (e && e.parameter) ? e.parameter : {};
    const action = String(params.action || "").trim();
    if (action === "health") {
      return jsonOutput_({ ok: true, service: "student-report-v8", version: "1.3.3" });
    }
    const forceRefresh = String(params.fresh || "") === "1";
    return jsonOutput_(getApiResponse_(forceRefresh));
  } catch (error) {
    return jsonOutput_({ ok: false, error: errorMessage_(error) });
  }
}

function doPost(e) {
  try {
    const payload = parsePostPayload_(e);
    const action = String(payload.action || "").trim();

    if (action === "resolveIllustrations") {
      return jsonOutput_(resolveIllustrations_(payload));
    }

    if (action === "resolveListItems") {
      return jsonOutput_(resolveListItems_(payload));
    }

    if (action === "resolvePdf") {
      return jsonOutput_(resolvePdf_(payload));
    }

    if (action === "uploadReport") {
      return jsonOutput_(uploadReport_(payload));
    }

    if (action === "findSubmission") {
      return jsonOutput_(findSubmission_(payload));
    }

    return jsonOutput_({ ok: false, error: "Action khong hop le." });
  } catch (error) {
    return jsonOutput_({ ok: false, error: errorMessage_(error) });
  }
}

function getSpreadsheet_() {
  if (CONFIG.SPREADSHEET_ID) {
    return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error("Khong tim thay Google Sheet. Neu day la standalone script, hay dien CONFIG.SPREADSHEET_ID.");
  }
  return ss;
}

function getDataSheet_() {
  const ss = getSpreadsheet_();
  if (CONFIG.SHEET_NAME) {
    const sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
    if (!sheet) throw new Error("Khong tim thay sheet: " + CONFIG.SHEET_NAME);
    return sheet;
  }
  const sheets = ss.getSheets();
  if (!sheets.length) throw new Error("Google Sheet khong co sheet nao.");
  return sheets[0];
}

function getApiResponse_(forceRefresh) {
  const cache = CacheService.getScriptCache();
  const cacheKey = "posttool_task_payload_v133";

  if (!forceRefresh) {
    try {
      const cached = cache.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch (_) {}
  }

  const sheet = getDataSheet_();
  const values = sheet.getDataRange().getDisplayValues();
  if (!values.length) return {};

  const rows = parseSheetRows_(values);
  // Giu dung format API hien tai cua thay: bang doc A:B -> tra ve 1 object JSON.
  // Neu sau nay dung bang ngang (header o dong 1) -> tra ve mang cac object.
  const response = looksLikeVerticalKeyValue_(values) ? (rows[0] || {}) : rows;

  // Cache rat ngan de khi 32 may mo cung luc, Apps Script khong phai doc
  // Google Sheet lap lai hang chuc lan. Neu Sheet vua duoc sua, toi da chi tre
  // vai giay; nut "Tai lai du lieu" tren web se gui fresh=1 de bo qua cache.
  try {
    cache.put(cacheKey, JSON.stringify(response), Math.max(1, CONFIG.TASK_CACHE_SECONDS || 2));
  } catch (_) {}
  return response;
}

function getSheetRows_() {
  const sheet = getDataSheet_();
  const values = sheet.getDataRange().getDisplayValues();
  return parseSheetRows_(values);
}

function parseSheetRows_(values) {
  if (!values || !values.length) return [];

  // Phieu hien tai cua thay dung kieu doc:
  // Cot A = ten truong (Tittle, Content, List Image, Folder, ...),
  // Cot B = gia tri. Tu dong nhan dien de tra ve 1 object JSON.
  if (looksLikeVerticalKeyValue_(values)) {
    const obj = {};
    values.forEach(function (row) {
      const key = String((row && row[0]) || "").trim();
      if (!key) return;
      obj[key] = row && row.length > 1 && row[1] !== undefined ? row[1] : "";
    });
    return Object.keys(obj).length ? [obj] : [];
  }

  // Van ho tro kieu bang ngang neu sau nay thay chuyen sang:
  // Dong 1 = header; moi dong tiep theo = 1 nhiem vu.
  const headers = values[0].map(function (value) {
    return String(value || "").trim();
  });

  return values.slice(1)
    .filter(function (row) {
      return row.some(function (value) { return String(value || "").trim() !== ""; });
    })
    .map(function (row) {
      const obj = {};
      headers.forEach(function (header, index) {
        if (!header) return;
        obj[header] = row[index] === undefined ? "" : row[index];
      });
      return obj;
    });
}

function looksLikeVerticalKeyValue_(values) {
  if (!Array.isArray(values) || !values.length) return false;

  const knownKeys = {
    "tittle": true,
    "title": true,
    "content": true,
    "list image": true,
    "folder": true,
    "number of textbox": true,
    "layout": true
  };

  let knownCount = 0;
  let nonEmptyFirstCol = 0;
  let textboxNameCount = 0;

  values.forEach(function (row) {
    const key = String((row && row[0]) || "").trim();
    if (!key) return;
    nonEmptyFirstCol++;
    const lower = key.toLowerCase();
    if (knownKeys[lower]) knownCount++;
    if (/^textbox\s*name\s*\d+$/i.test(key)) textboxNameCount++;
  });

  // Chi can nhin thay it nhat 2 truong cau hinh dac trung,
  // hoac 1 truong dac trung + cac Textbox name la du tin cay de coi la bang doc.
  return nonEmptyFirstCol >= 2 && (knownCount >= 2 || (knownCount >= 1 && textboxNameCount >= 1));
}

function parsePostPayload_(e) {
  if (e && e.postData && e.postData.contents) {
    const raw = String(e.postData.contents || "").trim();
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object") return parsed;
      } catch (_) {
        // Neu khong phai JSON thi thu e.parameter ben duoi.
      }
    }
  }
  return (e && e.parameter) ? e.parameter : {};
}

function jsonOutput_(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}

function errorMessage_(error) {
  return error && error.message ? String(error.message) : String(error || "Loi khong xac dinh");
}

function normalize_(value) {
  return String(value === null || value === undefined ? "" : value).trim().replace(/\s+/g, " ");
}

function getFieldCI_(obj, names) {
  const keys = Object.keys(obj || {});
  for (let i = 0; i < names.length; i++) {
    const wanted = String(names[i]).toLowerCase().trim();
    for (let k = 0; k < keys.length; k++) {
      if (String(keys[k]).toLowerCase().trim() === wanted) return obj[keys[k]];
    }
  }
  return "";
}

function getFolderValueFromRow_(row) {
  return normalize_(getFieldCI_(row, [
    "Folder", "Report Folder", "Google Drive Folder", "Thư mục", "Thu muc"
  ]));
}

function getListImageValueFromRow_(row) {
  return String(getFieldCI_(row, [
    "List Image", "List Images", "Image List", "Danh sách ảnh", "Danh sach anh"
  ]) || "").trim();
}

function extractDriveFolderId_(url) {
  const text = String(url || "");
  let match = text.match(/drive\.google\.com\/drive\/(?:u\/\d+\/)?folders\/([a-zA-Z0-9_-]+)/i);
  if (!match) match = text.match(/drive\.google\.com\/folders\/([a-zA-Z0-9_-]+)/i);
  return match ? match[1] : "";
}

function extractDriveFileId_(url) {
  const text = String(url || "");
  const patterns = [
    /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/i,
    /drive\.google\.com\/open\?[^#]*\bid=([a-zA-Z0-9_-]+)/i,
    /drive\.google\.com\/uc\?[^#]*\bid=([a-zA-Z0-9_-]+)/i,
    /drive\.google\.com\/thumbnail\?[^#]*\bid=([a-zA-Z0-9_-]+)/i
  ];
  for (let i = 0; i < patterns.length; i++) {
    const match = text.match(patterns[i]);
    if (match) return match[1];
  }
  return "";
}

function cleanUrlToken_(value) {
  return String(value || "").trim().replace(/^[\"'(<]+|[\"')>.,]+$/g, "");
}

function isHttpUrl_(value) {
  return /^https?:\/\//i.test(String(value || "").trim());
}

function parseImageLinks_(value) {
  if (Array.isArray(value)) {
    return unique_(value.map(cleanUrlToken_).filter(isHttpUrl_));
  }

  const raw = String(value || "").trim();
  if (!raw) return [];

  if (raw.charAt(0) === "[" && raw.charAt(raw.length - 1) === "]") {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parseImageLinks_(parsed);
    } catch (_) {}
  }

  const found = raw.match(/https?:\/\/[^\s,;|]+/gi) || [];
  if (found.length) return unique_(found.map(cleanUrlToken_).filter(isHttpUrl_));

  return unique_(raw.split(/[\n,;|]+/).map(cleanUrlToken_).filter(isHttpUrl_));
}

function unique_(arr) {
  const seen = {};
  return arr.filter(function (value) {
    const key = String(value);
    if (seen[key]) return false;
    seen[key] = true;
    return true;
  });
}

function isAllowedListImageValue_(value) {
  const wanted = String(value || "").trim();
  if (!wanted) return false;
  return getSheetRows_().some(function (row) {
    return getListImageValueFromRow_(row) === wanted;
  });
}

function getAllowedFolderIds_() {
  const ids = {};
  getSheetRows_().forEach(function (row) {
    const id = extractDriveFolderId_(getFolderValueFromRow_(row));
    if (id) ids[id] = true;
  });
  return ids;
}

function isAllowedListItemUrl_(sourceUrl) {
  const wanted = cleanUrlToken_(sourceUrl);
  if (!wanted) return false;
  return getSheetRows_().some(function (row) {
    return parseImageLinks_(getListImageValueFromRow_(row)).some(function (url) {
      return cleanUrlToken_(url) === wanted;
    });
  });
}

function resolveListItems_(payload) {
  const listImage = String(payload.listImage || "").trim();
  if (!listImage) return { ok: true, items: [] };
  if (!isAllowedListImageValue_(listImage)) {
    throw new Error("List Image khong nam trong du lieu Google Sheet hien tai.");
  }

  const links = parseImageLinks_(listImage);
  const items = links.map(function (url) {
    const folderId = extractDriveFolderId_(url);
    if (folderId) return { sourceUrl: url, type: "drive-folder", folderId: folderId };

    const fileId = extractDriveFileId_(url);
    if (fileId) {
      try {
        const file = DriveApp.getFileById(fileId);
        const mimeType = String(file.getMimeType() || "");
        let type = "file";
        if (mimeType === MimeType.PDF || mimeType === "application/pdf") type = "pdf";
        else if (mimeType.indexOf("image/") === 0) type = "image";
        return {
          sourceUrl: url,
          type: type,
          fileId: fileId,
          name: file.getName(),
          mimeType: mimeType,
          size: file.getSize()
        };
      } catch (error) {
        return { sourceUrl: url, type: "file", fileId: fileId, error: errorMessage_(error) };
      }
    }

    const lower = String(url || "").toLowerCase();
    if (/\.pdf(?:$|[?#])/.test(lower)) return { sourceUrl: url, type: "pdf" };
    return { sourceUrl: url, type: "image" };
  });

  return { ok: true, items: items };
}

function resolvePdf_(payload) {
  const sourceUrl = cleanUrlToken_(payload.sourceUrl || "");
  if (!sourceUrl || !isHttpUrl_(sourceUrl)) throw new Error("URL PDF khong hop le.");
  if (!isAllowedListItemUrl_(sourceUrl)) {
    throw new Error("PDF nay khong nam trong List Image cua Google Sheet hien tai.");
  }

  let blob;
  let name = "document.pdf";
  const fileId = extractDriveFileId_(sourceUrl);

  if (fileId) {
    const file = DriveApp.getFileById(fileId);
    const mimeType = String(file.getMimeType() || "");
    if (mimeType !== MimeType.PDF && mimeType !== "application/pdf") {
      throw new Error("File Google Drive nay khong phai PDF.");
    }
    blob = file.getBlob();
    name = file.getName() || name;
  } else {
    const response = UrlFetchApp.fetch(sourceUrl, {
      method: "get",
      followRedirects: true,
      muteHttpExceptions: true,
      validateHttpsCertificates: true
    });
    const code = response.getResponseCode();
    if (code < 200 || code >= 300) throw new Error("Khong tai duoc PDF (HTTP " + code + ").");
    blob = response.getBlob();
    const contentType = String(blob.getContentType() || "").toLowerCase();
    const blobName = String(blob.getName() || "");
    if (contentType.indexOf("application/pdf") === -1 && !/\.pdf$/i.test(blobName) && !/\.pdf(?:$|[?#])/i.test(sourceUrl)) {
      throw new Error("URL khong tra ve file PDF hop le.");
    }
    name = blobName || name;
  }

  const bytes = blob.getBytes();
  if (!bytes || !bytes.length) throw new Error("File PDF rong.");
  if (bytes.length > CONFIG.MAX_PDF_BYTES) {
    throw new Error("PDF vuot qua gioi han " + Math.round(CONFIG.MAX_PDF_BYTES / 1024 / 1024) + " MB.");
  }

  return {
    ok: true,
    name: name,
    size: bytes.length,
    base64: Utilities.base64Encode(bytes)
  };
}

function resolveIllustrations_(payload) {
  const listImage = String(payload.listImage || "").trim();
  if (!listImage) return { ok: true, images: [], warnings: [] };

  // Chi cho phep server doc dung List Image da duoc khai bao trong Sheet.
  if (!isAllowedListImageValue_(listImage)) {
    throw new Error("List Image khong nam trong du lieu Google Sheet hien tai.");
  }

  const links = parseImageLinks_(listImage);
  const images = [];
  const warnings = [];

  for (let i = 0; i < links.length && images.length < CONFIG.MAX_ILLUSTRATIONS; i++) {
    const url = links[i];
    const folderId = extractDriveFolderId_(url);
    const fileId = extractDriveFileId_(url);

    try {
      if (folderId) {
        const folder = DriveApp.getFolderById(folderId);
        const files = folder.getFiles();
        while (files.hasNext() && images.length < CONFIG.MAX_ILLUSTRATIONS) {
          const file = files.next();
          const mimeType = String(file.getMimeType() || "");
          if (mimeType.indexOf("image/") !== 0) continue;
          const item = blobToImageItem_(file.getBlob(), url, file.getName());
          if (item) images.push(item);
        }
        continue;
      }

      if (fileId) {
        const file = DriveApp.getFileById(fileId);
        const mimeType = String(file.getMimeType() || "");
        if (mimeType.indexOf("image/") !== 0) continue;
        const item = blobToImageItem_(file.getBlob(), url, file.getName());
        if (item) images.push(item);
        continue;
      }

      const response = UrlFetchApp.fetch(url, {
        method: "get",
        followRedirects: true,
        muteHttpExceptions: true,
        validateHttpsCertificates: true
      });
      const code = response.getResponseCode();
      if (code < 200 || code >= 300) {
        warnings.push("Khong tai duoc mot anh minh hoa (HTTP " + code + ").");
        continue;
      }
      const blob = response.getBlob();
      const item = blobToImageItem_(blob, url, "");
      if (item) images.push(item);
      else warnings.push("Mot URL khong tra ve file anh hop le.");
    } catch (error) {
      warnings.push("Khong doc duoc mot anh minh hoa: " + errorMessage_(error));
    }
  }

  if (links.length > CONFIG.MAX_ILLUSTRATIONS) {
    warnings.push("Danh sach anh qua dai; bao cao chi lay " + CONFIG.MAX_ILLUSTRATIONS + " anh dau tien.");
  }

  return { ok: true, images: images, warnings: warnings };
}

function blobToImageItem_(blob, sourceUrl, name) {
  if (!blob) return null;
  const bytes = blob.getBytes();
  if (!bytes || !bytes.length) return null;
  if (bytes.length > CONFIG.MAX_IMAGE_BYTES) {
    throw new Error("Anh vuot qua gioi han " + Math.round(CONFIG.MAX_IMAGE_BYTES / 1024 / 1024) + " MB.");
  }

  let mimeType = String(blob.getContentType() || "");
  if (mimeType.indexOf("image/") !== 0) {
    // UrlFetch co the tra application/octet-stream cho mot so may chu anh.
    const fileName = String(name || blob.getName() || "").toLowerCase();
    if (/\.png$/.test(fileName)) mimeType = "image/png";
    else if (/\.jpe?g$/.test(fileName)) mimeType = "image/jpeg";
    else if (/\.gif$/.test(fileName)) mimeType = "image/gif";
    else if (/\.webp$/.test(fileName)) mimeType = "image/webp";
    else return null;
  }

  return {
    name: String(name || blob.getName() || ""),
    sourceUrl: String(sourceUrl || ""),
    dataUrl: "data:" + mimeType + ";base64," + Utilities.base64Encode(bytes)
  };
}

function normalizeSubmissionId_(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._:-]+/g, "")
    .substring(0, 160);
}

function digestHex_(value) {
  const bytes = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(value || ""),
    Utilities.Charset.UTF_8
  );
  return bytes.map(function(byte) {
    const n = byte < 0 ? byte + 256 : byte;
    return ("0" + n.toString(16)).slice(-2);
  }).join("");
}

function submissionCacheKey_(folderId, submissionId) {
  return "posttool_sub_" + digestHex_(folderId + "|" + submissionId).substring(0, 40);
}

function submissionPropertyKey_(folderId, submissionId) {
  return "posttool_subp_" + digestHex_(folderId + "|" + submissionId).substring(0, 40);
}

function counterPropertyKey_(folderId, baseName) {
  return "posttool_ctr_" + digestHex_(folderId + "|" + baseName).substring(0, 40);
}

function fileResult_(file, baseName, extra) {
  const name = String(file.getName() || "");
  const escaped = escapeRegExp_(baseName || "");
  const match = name.match(new RegExp("^" + escaped + "_(\\d+)\\.png$", "i"));
  const result = {
    ok: true,
    found: true,
    attempt: match ? parseInt(match[1], 10) : 0,
    fileName: name,
    fileId: file.getId(),
    fileUrl: file.getUrl()
  };
  if (extra) {
    Object.keys(extra).forEach(function(key) { result[key] = extra[key]; });
  }
  return result;
}

function getRememberedSubmission_(folderId, submissionId, baseName) {
  if (!submissionId) return null;
  const cacheKey = submissionCacheKey_(folderId, submissionId);
  const propertyKey = submissionPropertyKey_(folderId, submissionId);
  const cache = CacheService.getScriptCache();
  const props = PropertiesService.getScriptProperties();
  const candidates = [cache.get(cacheKey), props.getProperty(propertyKey)];

  for (let i = 0; i < candidates.length; i++) {
    const raw = candidates[i];
    if (!raw) continue;
    try {
      const saved = JSON.parse(raw);
      if (!saved.fileId) continue;
      const file = DriveApp.getFileById(saved.fileId);
      return fileResult_(file, baseName, { reused: true });
    } catch (_) {}
  }
  return null;
}

function rememberSubmission_(folderId, submissionId, result) {
  if (!submissionId || !result || !result.fileId) return;
  const value = JSON.stringify({
    fileId: result.fileId,
    fileName: result.fileName,
    attempt: result.attempt || 0
  });
  try {
    CacheService.getScriptCache().put(submissionCacheKey_(folderId, submissionId), value, 21600);
  } catch (_) {}
  try {
    PropertiesService.getScriptProperties().setProperty(submissionPropertyKey_(folderId, submissionId), value);
  } catch (_) {}
}

function findSubmission_(payload) {
  const folderUrl = String(payload.folderUrl || "").trim();
  const folderId = extractDriveFolderId_(folderUrl);
  if (!folderId) throw new Error("Truong Folder khong phai link Google Drive folder hop le.");

  const allowedFolderIds = getAllowedFolderIds_();
  if (!allowedFolderIds[folderId]) {
    throw new Error("Folder nay khong duoc khai bao trong cot Folder cua Google Sheet.");
  }

  const baseName = sanitizeBaseName_(payload.baseName || "");
  const submissionId = normalizeSubmissionId_(payload.submissionId || "");
  if (!baseName || !submissionId) return { ok: true, found: false };

  const remembered = getRememberedSubmission_(folderId, submissionId, baseName);
  if (remembered) return remembered;

  // Duong du phong hiem khi cache/property bi mat: tim marker trong description.
  const marker = "posttool-submission:" + submissionId;
  const folder = DriveApp.getFolderById(folderId);
  const files = folder.getFiles();
  while (files.hasNext()) {
    const file = files.next();
    try {
      if (String(file.getDescription() || "") === marker) {
        const result = fileResult_(file, baseName, { reused: true });
        rememberSubmission_(folderId, submissionId, result);
        return result;
      }
    } catch (_) {}
  }
  return { ok: true, found: false };
}

function uploadReport_(payload) {
  const folderUrl = String(payload.folderUrl || "").trim();
  const folderId = extractDriveFolderId_(folderUrl);
  if (!folderId) throw new Error("Truong Folder khong phai link Google Drive folder hop le.");

  const allowedFolderIds = getAllowedFolderIds_();
  if (!allowedFolderIds[folderId]) {
    throw new Error("Folder nay khong duoc khai bao trong cot Folder cua Google Sheet.");
  }

  const baseName = sanitizeBaseName_(payload.baseName || "");
  if (!baseName) throw new Error("Thieu ten file bao cao.");
  const submissionId = normalizeSubmissionId_(payload.submissionId || "");

  // Neu request bi retry/timeout, tra lai dung file da tao thay vi tao file moi.
  const remembered = getRememberedSubmission_(folderId, submissionId, baseName);
  if (remembered) return remembered;

  const imageData = String(payload.imageData || "");
  const match = imageData.match(/^data:image\/png;base64,(.+)$/);
  if (!match) throw new Error("Du lieu bao cao khong phai PNG hop le.");

  const bytes = Utilities.base64Decode(match[1]);
  if (bytes.length > CONFIG.MAX_REPORT_BYTES) {
    throw new Error("Bao cao PNG qua lon. Gioi han hien tai: " + Math.round(CONFIG.MAX_REPORT_BYTES / 1024 / 1024) + " MB.");
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(30000);

  try {
    const rememberedInsideLock = getRememberedSubmission_(folderId, submissionId, baseName);
    if (rememberedInsideLock) return rememberedInsideLock;

    const folder = DriveApp.getFolderById(folderId);
    // Khong scan toan bo folder. Bat dau tu so lan nop ma client goi y va chi
    // kiem tra cac ten file cua dung hoc sinh/bai nay. Nhanh hon nhieu khi folder lon.
    let attempt = Math.max(1, parseInt(payload.preferredAttempt || "1", 10) || 1);
    let fileName = baseName + "_" + attempt + ".png";
    while (folder.getFilesByName(fileName).hasNext()) {
      attempt += 1;
      fileName = baseName + "_" + attempt + ".png";
    }

    const blob = Utilities.newBlob(bytes, "image/png", fileName);
    const file = folder.createFile(blob);
    if (submissionId) {
      try { file.setDescription("posttool-submission:" + submissionId); } catch (_) {}
    }

    const result = fileResult_(file, baseName, { reused: false });
    rememberSubmission_(folderId, submissionId, result);
    return result;
  } finally {
    lock.releaseLock();
  }
}

function sanitizeBaseName_(value) {
  return normalize_(value)
    .replace(/[\\\/:*?"<>|]+/g, "-")
    .replace(/\.+$/g, "")
    .substring(0, 180)
    .trim();
}

function escapeRegExp_(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Chay ham nay 1 lan trong Apps Script editor de:
 * - cap quyen Spreadsheet/Drive cho script,
 * - kiem tra Folder,
 * - kiem tra List Image Google Drive,
 * - xem du lieu API da doc dung chua.
 */
function testSetup() {
  const rows = getSheetRows_();
  if (!rows.length) throw new Error("Sheet khong co du lieu hop le.");

  const row = rows[0];
  const result = {
    ok: true,
    apiData: getApiResponse_(),
    folder: null,
    images: []
  };

  const folderUrl = getFolderValueFromRow_(row);
  if (folderUrl) {
    const folderId = extractDriveFolderId_(folderUrl);
    if (!folderId) throw new Error("Gia tri Folder khong phai link Google Drive folder hop le.");
    const folder = DriveApp.getFolderById(folderId);
    result.folder = { id: folderId, name: folder.getName() };
  }

  const listImage = getListImageValueFromRow_(row);
  const links = parseImageLinks_(listImage);
  links.forEach(function (url) {
    const fileId = extractDriveFileId_(url);
    const folderId = extractDriveFolderId_(url);
    if (fileId) {
      const file = DriveApp.getFileById(fileId);
      result.images.push({ type: "file", id: fileId, name: file.getName(), mimeType: file.getMimeType() });
    } else if (folderId) {
      const folder = DriveApp.getFolderById(folderId);
      result.images.push({ type: "folder", id: folderId, name: folder.getName() });
    } else {
      result.images.push({ type: "web", url: url });
    }
  });

  console.log(JSON.stringify(result, null, 2));
  return result;
}
