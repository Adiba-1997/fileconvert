const fs = require("fs");
const path = require("path");

const BASE_DIR = __dirname;
const TOOLS_DIR = path.join(BASE_DIR, "public/tools");
const INDEX_FILE = path.join(BASE_DIR, "public/index.html");
const BACKUP_DIR = path.join(BASE_DIR, "backup-before-remove-adsjs");

// Create backup directory
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

const TARGET_REGEX = /<script\s+src=["']\/js\/ads\.js["']\s*><\/script>\s*/gi;

// Function to process one file
function processFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  let content = fs.readFileSync(filePath, "utf8");

  if (!TARGET_REGEX.test(content)) return;

  // Backup file
  const backupPath = path.join(BACKUP_DIR, path.basename(filePath));
  fs.writeFileSync(backupPath, content, "utf8");

  // Remove ads.js script
  content = content.replace(TARGET_REGEX, "");

  fs.writeFileSync(filePath, content, "utf8");
  console.log(`✅ Removed ads.js from: ${filePath}`);
}

// 1️⃣ Process index.html
processFile(INDEX_FILE);

// 2️⃣ Process all tool pages
fs.readdirSync(TOOLS_DIR).forEach(file => {
  if (file.endsWith(".html")) {
    processFile(path.join(TOOLS_DIR, file));
  }
});

console.log("🎉 ads.js removed from index.html and all tool pages");
console.log(`🛡️ Backup location: ${BACKUP_DIR}`);
