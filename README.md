# posttool

Ứng dụng **Phiếu trả lời** chạy trên Node.js + Express, sử dụng **EJS** làm view engine.

## Kiến trúc

```text
Trình duyệt
   │
   ├─ GET /                  → EJS view
   ├─ /api/task              → Express proxy → Google Apps Script → Google Sheet/Drive
   ├─ /api/uploads/image     → Multer + Sharp xử lý ảnh học sinh dán
   └─ /api/reports/submit    → Puppeteer/Chromium dựng PNG → Google Apps Script upload Drive
```

Điểm khác quan trọng so với bản web tĩnh: ảnh báo cáo **không còn phụ thuộc html2canvas ở trình duyệt**. Express dựng template `views/report.ejs`, Chromium render đầy đủ layout/ảnh, sau đó chụp PNG phía server.

## Thư viện chính

- `express`: web server.
- `ejs`: view engine.
- `multer`: nhận ảnh paste/drop theo multipart upload.
- `sharp`: xoay đúng EXIF, resize, nén ảnh sang WebP trước khi lưu tiến trình.
- `puppeteer-core`: dùng Chrome/Chromium để dựng báo cáo PNG chính xác hơn.
- `pdfjs-dist`: hiển thị PDF lật từng trang trên giao diện.
- `helmet`, `compression`, `morgan`: bảo mật header, nén response và log request.

## Cấu trúc thư mục

```text
posttool/
├─ server.js
├─ package.json
├─ .env.example
├─ Dockerfile
├─ start-windows.bat
├─ views/
│  ├─ index.ejs
│  └─ report.ejs
├─ public/
│  ├─ css/app.css
│  └─ js/app.js
├─ routes/
│  └─ api.js
├─ services/
│  ├─ googleAppsScript.js
│  └─ reportRenderer.js
├─ middleware/
│  └─ imageUpload.js
└─ apps-script/
   └─ Code.gs
```

## 1. Yêu cầu

- Node.js **20+**.
- Google Chrome, Microsoft Edge hoặc Chromium trên máy chạy server.
- Google Apps Script đã deploy Web App và hỗ trợ các action trong `apps-script/Code.gs`.

## 2. Cài đặt

```bash
cd posttool
npm install
```

Tạo `.env` từ `.env.example`:

```bash
copy .env.example .env
```

Trên macOS/Linux:

```bash
cp .env.example .env
```

Nếu endpoint Apps Script thay đổi, sửa:

```env
GOOGLE_APPS_SCRIPT_URL=https://script.google.com/macros/s/.../exec
```

Thông thường Posttool tự tìm Chrome/Edge. Nếu server không tìm thấy trình duyệt, đặt đường dẫn thủ công:

```env
CHROME_EXECUTABLE_PATH=C:\Program Files\Google\Chrome\Application\chrome.exe
```

hoặc Linux:

```env
CHROME_EXECUTABLE_PATH=/usr/bin/chromium
```

## 3. Chạy

```bash
npm start
```

Mở:

```text
http://localhost:3000
```

Kiểm tra server:

```text
http://localhost:3000/health
```

Trên Windows có thể chạy trực tiếp `start-windows.bat`.

## 4. Cơ chế Nộp bài

Frontend gửi dữ liệu bài làm tới:

```text
POST /api/reports/submit
```

Server dùng `report.ejs` + Chromium để dựng báo cáo và Sharp tối ưu PNG.

- Nếu JSON API có `Folder`: PNG được chuyển tiếp qua Apps Script và lưu trong Google Drive. Apps Script tự đánh số lần nộp theo file đã có.
- Nếu `Folder` trống: server trả PNG về trình duyệt để tải xuống máy.
- Nếu upload Drive lỗi: server tự trả PNG về máy làm bản dự phòng để tránh mất bài.

Quy tắc tên giữ dạng:

```text
Lớp_Họ tên_Title_Số lần nộp.png
```

Ví dụ:

```text
2A01_Nguyễn Văn An_Suy ngẫm về vấn đề sau_1.png
```

## 5. Ảnh học sinh dán vào textbox

Khi học sinh paste/drop ảnh, trình duyệt gửi ảnh tới:

```text
POST /api/uploads/image
```

`Multer` nhận file trong RAM; `Sharp` sẽ:

- đọc hướng EXIF và xoay đúng;
- giới hạn cạnh ảnh mặc định tối đa 1800 px;
- nén sang WebP;
- trả Data URL về frontend.

Nếu endpoint xử lý ảnh gặp lỗi, frontend vẫn có cơ chế nén ảnh tại trình duyệt làm fallback.

## 6. PDF

PDF trong `List Image` được hiển thị bằng `pdfjs-dist` cài trong project, không phụ thuộc CDN. Học sinh có thể lật từng trang. Trang PDF đang xem được chụp vào báo cáo khi nộp bài.

## 7. Google Apps Script

File dùng kèm:

```text
apps-script/Code.gs
```

Sau khi chỉnh Apps Script, cập nhật deployment hiện tại để giữ URL `/exec` nếu muốn.

## 8. Docker

```bash
docker build -t posttool .
docker run --rm -p 3000:3000 --env-file .env posttool
```

Dockerfile đã cài Chromium và font Noto để dựng tiếng Việt ổn định.
