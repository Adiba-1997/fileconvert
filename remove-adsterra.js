const fs = require("fs");
const path = require("path");

const TOOLS_DIR = path.join(__dirname, "public/tools");
const BACKUP_DIR = path.join(__dirname, "backup-tools-before-adsense");

// Create backup folder if not exists
if (!fs.existsSync(BACKUP_DIR)) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

// Patterns to remove (Adsterra related)
const patterns = [
  /<!-- ADSTER[\s\S]*?END -->/gi,
  /<style[^>]*id=["']adster-styles["'][\s\S]*?<\/style>/gi,
  /<script[^>]*src=["'][^"']*highperformanceformat\.com[^"']*["'][\s\S]*?<\/script>/gi,
  /<script[\s\S]*?atOptions[\s\S]*?<\/script>/gi,
  /<div[^>]*adster[^>]*>[\s\S]*?<\/div>/gi,
  /<script[^>]*id=["']adster-sticky-script["'][\s\S]*?<\/script>/gi,
  /<script[^>]*src=["']\/js\/ads\.js["'][\s\S]*?<\/script>/gi
];

let cleanedFiles = 0;

// Process each HTML file
fs.readdirSync(TOOLS_DIR).forEach(file => {
  if (!file.endsWith(".html")) return;

  const filePath = path.join(TOOLS_DIR, file);
  const backupPath = path.join(BACKUP_DIR, file);

  let content = fs.readFileSync(filePath, "utf8");

  // Backup original file
  fs.writeFileSync(backupPath, content, "utf8");

  // Remove Adsterra patterns
  patterns.forEach(pattern => {
    content = content.replace(pattern, "");
  });

  fs.writeFileSync(filePath, content, "utf8");
  cleanedFiles++;
});

console.log(`✅ Backup created in: ${BACKUP_DIR}`);
console.log(`🧹 Adsterra removed from ${cleanedFiles} tool files`);
