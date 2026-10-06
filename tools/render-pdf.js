const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const docsDir = path.join(__dirname, 'docs');
if (!fs.existsSync(docsDir)) {
  fs.mkdirSync(docsDir, { recursive: true });
}

const htmlPath = path.join(docsDir, 'DOKUMENTASI_PROYEK_LENGKAP.html');
const pdfPath = path.join(__dirname, 'DOKUMENTASI_PROYEK_RBM.pdf');

// Render PDF using Microsoft Edge / Chrome headless
const edgePaths = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
];

let browserExe = null;
for (const p of edgePaths) {
  if (fs.existsSync(p)) {
    browserExe = p;
    break;
  }
}

if (!browserExe) {
  console.error('No headless browser found to compile PDF.');
  process.exit(1);
}

console.log('Generating PDF using browser:', browserExe);
const normalizedHtmlUrl = 'file:///' + htmlPath.replace(/\\/g, '/');
const cmd = `"${browserExe}" --headless --disable-gpu --run-all-compositor-stages-before-draw --print-to-pdf="${pdfPath}" --no-pdf-header-footer "${normalizedHtmlUrl}"`;

try {
  execSync(cmd, { stdio: 'inherit' });
  console.log('PDF successfully created at:', pdfPath);
} catch (err) {
  console.error('Error generating PDF:', err.message);
}
