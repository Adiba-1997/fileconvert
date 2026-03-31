/**
 * Adsterra Ad Placement Updater v2
 * ---------------------------------
 * Places Adsterra ads:
 *  1️⃣ Below breadcrumbs block
 *  2️⃣ Above "About this tool"
 *  3️⃣ Above FAQ block
 *  4️⃣ Sticky ad bottom
 */

const fs = require("fs");
const path = require("path");

// ✅ Source & Backup Directories
const SOURCE_DIRS = [
  path.join(__dirname, "public"),
  path.join(__dirname, "tools", "public"),
];
const BACKUP_DIRS = [
  path.join(__dirname, "public-backup-html"),
  path.join(__dirname, "tools-backup-html"),
];

// 🧱 Ad Blocks
const adTop = `
<!-- 🧭 Ad Below Breadcrumbs -->
<div class="adsterra-top" style="text-align:center;margin:15px 0;">
  <script type="text/javascript">
    atOptions = {
      'key' : '6492e76bc4089918d0c88245d8c99e53',
      'format' : 'iframe',
      'height' : 90,
      'width' : 728,
      'params' : {}
    };
  </script>
  <script type="text/javascript" src="//www.highperformanceformat.com/6492e76bc4089918d0c88245d8c99e53/invoke.js"></script>
</div>
`;

const adMid = `
<!-- 🧩 Ad Above "About this tool" -->
<div class="adsterra-mid" style="text-align:center;margin:15px 0;">
  <script type="text/javascript">
    atOptions = {
      'key' : 'f9c9afe06b33fd851dd0d8d57684ded8',
      'format' : 'iframe',
      'height' : 250,
      'width' : 300,
      'params' : {}
    };
  </script>
  <script type="text/javascript" src="//www.highperformanceformat.com/f9c9afe06b33fd851dd0d8d57684ded8/invoke.js"></script>
</div>
`;

const adFAQ = `
<!-- 📘 Ad Above FAQ -->
<div class="adsterra-faq" style="text-align:center;margin:15px 0;">
  <script type="text/javascript">
    atOptions = {
      'key' : 'f9c9afe06b33fd851dd0d8d57684ded8',
      'format' : 'iframe',
      'height' : 250,
      'width' : 300,
      'params' : {}
    };
  </script>
  <script type="text/javascript" src="//www.highperformanceformat.com/f9c9afe06b33fd851dd0d8d57684ded8/invoke.js"></script>
</div>
`;

const stickyAd = `
<!-- 📱 Sticky Bottom Ad -->
<div id="adsterra-sticky" style="position:fixed;bottom:0;left:0;width:100%;text-align:center;z-index:9999;background:#fff;padding:4px 0;box-shadow:0 -3px 10px rgba(0,0,0,0.1);">
  <div id="container-b7c6b4998c406d004e3059afe0728b76"></div>
  <script async data-cfasync="false" src="//pl27603070.effectivegatecpm.com/b7c6b4998c406d004e3059afe0728b76/invoke.js"></script>
  <button onclick="document.getElementById('adsterra-sticky').remove()" style="position:absolute;right:5px;top:-8px;background:#000;color:#fff;border:none;border-radius:50%;width:25px;height:25px;cursor:pointer;">×</button>
</div>
`;

function ensureBackupDir(baseDir, backupDir) {
  if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir, { recursive: true });

  const files = fs.readdirSync(baseDir);
  for (const file of files) {
    const src = path.join(baseDir, file);
    const dest = path.join(backupDir, file);

    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      ensureBackupDir(src, dest);
    } else if (file.endsWith(".html")) {
      fs.copyFileSync(src, dest);
      console.log(`🗂️ Backup created: ${dest}`);
    }
  }
}

function cleanAndInsertAds(filePath) {
  let html = fs.readFileSync(filePath, "utf8");

  // 🧹 Remove any existing ad blocks
  html = html.replace(
    /<script[^>]*(highperformanceformat\.com|effectivegatecpm\.com)[\s\S]*?<\/script>/gi,
    ""
  );
  html = html.replace(/<div[^>]*(adsterra|ad-slot|container-)[^>]*>[\s\S]*?<\/div>/gi, "");

  // 🧭 Insert ad below breadcrumbs
  html = html.replace(/(<div[^>]*class=["'][^"']*breadcrumbs[^"']*["'][^>]*>[\s\S]*?<\/div>)/i, `$1\n${adTop}`);

  // 🧩 Insert ad above “About this tool”
  html = html.replace(/(<h2[^>]*>About this tool<\/h2>)/i, `${adMid}\n$1`);

  // 📘 Insert ad above FAQ section
  html = html.replace(/(<h2[^>]*>FAQ<\/h2>)/i, `${adFAQ}\n$1`);

  // 📱 Add sticky ad at bottom
  html = html.replace(/<\/body>/i, `${stickyAd}\n</body>`);

  fs.writeFileSync(filePath, html, "utf8");
  console.log(`✅ Updated ads in: ${filePath}`);
}

function processDir(srcDir, backupDir) {
  ensureBackupDir(srcDir, backupDir);
  const files = fs.readdirSync(srcDir);

  for (const file of files) {
    const fullPath = path.join(srcDir, file);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      processDir(fullPath, path.join(backupDir, file));
    } else if (file.endsWith(".html")) {
      cleanAndInsertAds(fullPath);
    }
  }
}

console.log("🚀 Updating Adsterra placements on all pages...");
for (let i = 0; i < SOURCE_DIRS.length; i++) {
  if (fs.existsSync(SOURCE_DIRS[i])) processDir(SOURCE_DIRS[i], BACKUP_DIRS[i]);
}
console.log("🎉 All done! Ads placed at: Below breadcrumbs, above About, above FAQ, and sticky bottom.");
