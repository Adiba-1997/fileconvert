const fs = require('fs');
const path = require('path');

const publicDir = path.join(__dirname, 'public');
const toolsDir = path.join(publicDir, 'tools');

function restoreBackups(dirPath) {
  if (!fs.existsSync(dirPath)) return;
  const files = fs.readdirSync(dirPath);

  files.forEach(file => {
    const fullPath = path.join(dirPath, file);
    const stat = fs.statSync(fullPath);

    if (stat.isDirectory()) {
      restoreBackups(fullPath);
    } else if (file.endsWith('.html.bak')) {
      const originalFile = fullPath.replace('.bak', '');
      fs.copyFileSync(fullPath, originalFile);
      console.log(`Restored: ${originalFile}`);
    }
  });
}

// Restore backups in /public and /public/tools
restoreBackups(publicDir);
restoreBackups(toolsDir);

console.log('All backups restored.');
