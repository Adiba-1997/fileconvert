const fs = require('fs');
const path = require('path');

const directories = [
  path.join(__dirname, 'public'),
  path.join(__dirname, 'public', 'tools')
];

// Regex patterns to remove old ads
const adPatterns = [
  /<script[^>]*>.*?atOptions.*?<\/script>/gs,
  /<script[^>]*src=["'][^"']*highperformanceformat[^"']*["'][^>]*><\/script>/gs,
  /<div class="ad[^>]*>.*?<\/div>/gs,
];

// Placeholders for new ads
const placeholders = {
  top: '<div class="ad-top"></div>',
  belowConvert: '<div class="ad-below-convert"></div>',
  beforeFaq: '<div class="ad-before-faq"></div>',
  mobileSticky: '<div class="mobile-sticky-ad"></div>'
};

function processFile(filePath) {
  let content = fs.readFileSync(filePath, 'utf8');

  // Remove old ad scripts and divs
  adPatterns.forEach(pattern => {
    content = content.replace(pattern, '');
  });

  // Inject placeholders if missing
  if (!content.includes('class="ad-top"')) {
    content = content.replace(/(<nav class="navbar">.*?<\/nav>)/s, `$1\n${placeholders.top}`);
  }

  if (!content.includes('class="ad-below-convert"')) {
    content = content.replace(/(<\/form>)/s, `$1\n${placeholders.belowConvert}`);
  }

  if (!content.includes('class="ad-before-faq"')) {
    content = content.replace(/(<div class="tool-section faq-section">)/s, `${placeholders.beforeFaq}\n$1`);
  }

  if (!content.includes('class="mobile-sticky-ad"')) {
    content = content.replace(/(<\/body>)/s, `${placeholders.mobileSticky}\n$1`);
  }

  fs.writeFileSync(filePath, content, 'utf8');
  console.log(`Processed: ${filePath}`);
}

directories.forEach(dir => {
  if (fs.existsSync(dir)) {
    fs.readdirSync(dir).forEach(file => {
      const fullPath = path.join(dir, file);
      if (fs.statSync(fullPath).isFile() && file.endsWith('.html')) {
        processFile(fullPath);
      }
    });
  } else {
    console.warn(`Directory does not exist: ${dir}`);
  }
});
