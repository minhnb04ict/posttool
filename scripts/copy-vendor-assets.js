const fs = require('fs');
const path = require('path');

function copyFile(from, to) {
  if (!fs.existsSync(from)) {
    throw new Error(`Missing vendor asset: ${from}`);
  }
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  console.log(`Copied ${path.basename(from)} -> ${path.relative(path.join(__dirname, '..'), to)}`);
}

const root = path.join(__dirname, '..');
copyFile(
  path.join(root, 'node_modules', 'pdfjs-dist', 'build', 'pdf.min.js'),
  path.join(root, 'public', 'vendor', 'pdfjs', 'pdf.min.js')
);
copyFile(
  path.join(root, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.js'),
  path.join(root, 'public', 'vendor', 'pdfjs', 'pdf.worker.min.js')
);
copyFile(
  path.join(root, 'node_modules', 'html2canvas', 'dist', 'html2canvas.min.js'),
  path.join(root, 'public', 'vendor', 'html2canvas', 'html2canvas.min.js')
);

copyFile(
  path.join(root, 'node_modules', 'axios', 'dist', 'axios.min.js'),
  path.join(root, 'public', 'vendor', 'axios', 'axios.min.js')
);
