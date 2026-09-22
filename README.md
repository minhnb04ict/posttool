# Posttool 1.3.2

> **Fast Upload + chống nộp trùng.** Mỗi lần bấm **Nộp bài** tạo một `submissionId` duy nhất. Google Apps Script ghi nhớ mã này nên retry, timeout hoặc chuyển sang fallback vẫn trả về đúng file đã tạo thay vì tạo `_1`, `_2` cho cùng một lần bấm.

## Thay đổi quan trọng 1.3.2

- **Fast path mặc định:** trình duyệt dựng PNG bằng `html2canvas` rồi upload duy nhất file PNG qua `/api/reports/upload`. Chromium/Puppeteer chỉ còn là fallback.
- **Không chạy Sharp lại trên PNG fast path** nếu client đã tạo PNG hợp lệ -> giảm CPU/thời gian trên Vercel.
- **Idempotency end-to-end:** `submissionId` đi từ browser -> Express -> Apps Script.
- **Xác nhận sau timeout:** nếu upload báo lỗi nhưng Drive có thể đã nhận file, frontend gọi `/api/reports/status` trước khi render/upload lại.
- **Google Apps Script có `findSubmission`:** dùng CacheService + ScriptProperties + file description để tìm lại đúng lần nộp.
- **Đánh số nhanh hơn:** Apps Script bắt đầu từ số lần nộp phía client gợi ý và chỉ kiểm tra `baseName_1.png`, `baseName_2.png`... bằng `getFilesByName()`, không quét toàn bộ folder.
- **Prefetch ảnh minh họa khi học sinh bắt đầu làm bài:** giảm thời gian chờ lúc bấm Nộp bài.

> **BẮT BUỘC:** phải redeploy `apps-script/Code.gs` của bản 1.3.2. Nếu chỉ thay Node/EJS mà giữ Apps Script cũ thì cơ chế chống trùng không hoạt động.

## Luồng nộp bài 1.3.2

```text
FAST PATH (mặc định)
Trình duyệt -> html2canvas -> PNG nén -> Express multipart -> Apps Script -> Drive

FALLBACK
Nếu thiết bị không dựng được PNG:
Trình duyệt -> Express -> Puppeteer/Chromium -> PNG -> Apps Script -> Drive
```

Để ép dùng renderer server làm chính (không khuyến nghị nếu ưu tiên tốc độ):

```text
REPORT_STRATEGY=server-first
```

Mặc định không cần khai báo: `client-first`.

# posttool 1.3

Ứng dụng **Phiếu trả lời** chạy trên **Node.js + Express + EJS**. Bản 1.3 được thiết kế theo hướng hybrid để vẫn nộp được bài khi Chromium trên Vercel gặp sự cố hoặc bài có nhiều ảnh.

## Kiến trúc

```text
Trình duyệt
   │
   ├─ GET /                         → EJS view
   ├─ /api/task                     → Express proxy → Google Apps Script
   ├─ /api/uploads/image            → Multer + Sharp (fallback xử lý ảnh)
   ├─ /api/reports/submit           → Puppeteer/Chromium → PNG
   ├─ /api/media/illustrations      → Apps Script → Sharp → ảnh report fallback
   └─ /api/reports/upload           → upload PNG fallback → Google Drive
```

### Hai lớp tạo báo cáo

1. **Chính (nhanh):** trình duyệt dựng PNG bằng `html2canvas`, nén và upload duy nhất file PNG qua Express.
2. **Dự phòng:** nếu thiết bị không dựng được PNG, Express dựng `views/report.ejs` bằng Puppeteer + Chromium rồi upload. Nếu Drive/server tiếp tục lỗi, bài làm vẫn được giữ để thử lại; chỉ tải PNG về máy khi hệ thống thực sự không xác nhận được upload.

Học sinh không cần chọn chế độ nào; frontend tự chuyển fallback.

## Thư viện chính

- `express`, `ejs`: web server và view.
- `puppeteer-core` + `@sparticuz/chromium`: renderer chính trên Vercel.
- `html2canvas`: renderer dự phòng trên thiết bị.
- `sharp`: resize/nén ảnh và PNG.
- `multer`: multipart upload.
- `pdfjs-dist`: PDF lật trang khi file đủ nhỏ.
- `helmet`, `compression`, `morgan`: header, nén response, logging.

## Các lỗi đã được phòng tránh

- Chromium không tồn tại trên Vercel → dùng `@sparticuz/chromium`.
- Chromium crash/disconnect → tự khởi động lại và thử render lần 2.
- Vercel 413 / request quá lớn → không gửi JSON lớn; tự render trên thiết bị.
- PNG response quá lớn → server nén/downscale PNG; fallback cũng ép dưới khoảng 3.35 MB.
- Google Drive upload lỗi → tải PNG về thiết bị.
- Ảnh điện thoại quá lớn → nén tại trình duyệt trước, không gửi ảnh gốc qua Vercel.
- Mobile không paste clipboard được → mỗi textbox có nút **＋ Ảnh** để chọn camera/thư viện ảnh.
- `localStorage` đầy vì ảnh → tiến trình đầy đủ được lưu bằng IndexedDB; localStorage chỉ làm fallback.
- API thay đổi → reset bài làm, chỉ giữ Họ tên + Lớp; API không đổi → khôi phục tiến trình.
- PDF lớn → dùng Google Drive/browser PDF viewer fallback thay vì đẩy base64 lớn qua Vercel.
- Báo cáo rất dài → renderer server chia ảnh theo đoạn rồi ghép bằng Sharp.
- Số lần nộp local không bị tăng nếu lần nộp thất bại.

## Thiết bị và trình duyệt mục tiêu

Bản 1.3 ưu tiên các trình duyệt hiện đại có JavaScript/IndexedDB:

- Windows/macOS: Chrome, Edge, Safari hiện đại.
- Chromebook/ChromeOS: Chrome.
- Android: Chrome/WebView hiện đại.
- iPhone/iPad: Safari/Chrome (đều dùng WebKit); khi clipboard ảnh bị giới hạn, dùng nút **＋ Ảnh** để chọn Camera/Thư viện.

Ứng dụng có hai đường tạo báo cáo (server Chromium + client html2canvas), lưu tiến trình bằng IndexedDB với localStorage fallback, và tải PNG về thiết bị nếu Drive/server gặp lỗi. Không có ứng dụng web nào có thể cam kết tuyệt đối với mọi phiên bản trình duyệt/thiết bị, nhưng các đường fallback này giúp tránh mất bài trên những môi trường phổ biến.

## Cài đặt local

Yêu cầu Node.js 20+.

```bash
cd posttool
npm install
cp .env.example .env
npm start
```

Windows có thể chạy `start-windows.bat`.

Mở:

```text
http://localhost:3000
```

## Kiểm tra hệ thống

### Kiểm tra nhanh

```text
GET /health
```

### Kiểm tra sâu Apps Script + Chromium

```text
GET /health?deep=1
```

Nếu mọi thứ đúng, `ok` phải là `true` và trong `checks`:

```json
{
  "appsScript": { "ok": true },
  "renderer": { "ok": true }
}
```

Local cũng có thể chạy:

```bash
npm run check
```

## Vercel

Vercel nhận diện `server.js` là Express entry point. `public/**` được Vercel phục vụ qua CDN; `postinstall` copy PDF.js và html2canvas vào `public/vendor`.

Environment Variable bắt buộc/khuyến nghị:

```text
GOOGLE_APPS_SCRIPT_URL=https://script.google.com/macros/s/.../exec
GAS_TIMEOUT_MS=45000
GAS_RETRIES=2
```

Nếu deployment báo function bundle vượt giới hạn chuẩn, thêm trong Vercel Project Settings:

```text
VERCEL_SUPPORT_LARGE_FUNCTIONS=1
```

Sau deploy, kiểm tra:

```text
https://<domain>/health?deep=1
```

## Google Apps Script

Dùng file:

```text
apps-script/Code.gs
```

Sau khi thay code:

1. **Save**.
2. Chạy `testSetup()` một lần để cấp quyền Sheets/Drive.
3. `Deploy → Manage deployments → Edit → New version → Deploy`.
4. Giữ `Execute as: Me`.
5. Chọn mức `Who has access` phù hợp chính sách Google Workspace của trường.

Bản Apps Script này đọc Sheet dạng A:B hoặc bảng ngang, hỗ trợ:

- `resolveIllustrations`
- `resolveListItems`
- `resolvePdf`
- `uploadReport`

PDF custom viewer giới hạn khoảng 3 MB để không vượt payload Vercel. PDF lớn sẽ tự chuyển sang viewer nhúng.

## Quy tắc tên file

```text
Lớp_Họ tên_Title_Số lần nộp.png
```

Ví dụ:

```text
2A01_Nguyễn Văn An_Suy ngẫm về vấn đề sau_1.png
2A01_Nguyễn Văn An_Suy ngẫm về vấn đề sau_2.png
```

Nếu `Folder` có link, số lần nộp được tính từ file thực tế trong Google Drive và có `LockService` chống trùng khi nhiều học sinh nộp cùng lúc.

Nếu `Folder` trống hoặc Drive upload thất bại, file được tải về thiết bị.

## Docker

```bash
docker build -t posttool .
docker run --rm -p 3000:3000 --env-file .env posttool
```

Dockerfile cài Chromium và font Noto. `scripts/` được copy trước `npm install` để `postinstall` hoạt động đúng.

## Posttool 1.3.3 - Axios + tải đồng loạt nhiều máy

Phiên bản này bổ sung tối ưu cho tình huống giáo viên dùng NetSupport School mở trang cùng lúc trên khoảng 30-40 máy:

- Toàn bộ HTTP/API call phía Node -> Google Apps Script dùng `axios`.
- Frontend cũng dùng Axios cho `/api/task`, upload ảnh, PDF/List Image helper, kiểm tra trạng thái và nộp báo cáo.
- `GET /api/task` có **single-flight**: nhiều request tới cùng lúc chỉ dùng chung 1 request upstream tới Google Apps Script.
- Cache RAM rất ngắn ở Express (`TASK_CACHE_TTL_MS`, mặc định 2 giây) và stale fallback 5 phút nếu Apps Script tạm chậm.
- Header cache riêng cho CDN/Vercel giữ response 2 giây để giảm burst giữa nhiều serverless instance, nhưng browser vẫn `no-store`.
- Google Apps Script có `CacheService` 2 giây để tránh đọc Google Sheet lặp lại liên tục khi nhiều request tới cùng lúc.
- Frontend retry theo exponential backoff + jitter, tránh 32 máy retry đúng cùng một thời điểm.
- Khi API tạm lỗi nhưng thiết bị đã tải thành công trước đó, trang dùng snapshot API gần nhất trên máy thay vì hiện trang trắng; có nút **Tải lại dữ liệu** để force refresh.
- Mọi chuỗi `http://...` hoặc `https://...` trong `Title`/`Content` được tự động biến thành link có thể bấm mở tab mới.

### Environment Variables khuyến nghị

```env
TASK_CACHE_TTL_MS=2000
TASK_STALE_MS=300000
TASK_UPSTREAM_TIMEOUT_MS=10000
TASK_UPSTREAM_RETRIES=2
STARTUP_JITTER_MS=350
```

### Sau khi cập nhật Google Apps Script

Cần redeploy Apps Script bằng **Manage deployments -> Edit -> New version -> Deploy** để bật cache ngắn và hỗ trợ `fresh=1`.

Khi muốn bỏ qua mọi cache để kiểm tra ngay dữ liệu Sheet mới nhất, trên giao diện bấm **Tải lại dữ liệu** khi xuất hiện thông báo kết nối; request này gửi `fresh=1`.
