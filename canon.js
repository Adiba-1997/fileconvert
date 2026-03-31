const fs = require('fs');
const path = require('path');

// Folder containing your HTML files
const htmlFolder = './public/tools'; // your HTML files path
const baseUrl = 'https://fileconvert.co.in';

// Function to remove trailing slash from URL
const removeTrailingSlash = url => url.replace(/\/$/, '');

// Recursive function to process HTML files in folder and subfolders
function processFolder(folder) {
  fs.readdir(folder, (err, files) => {
    if (err) {
      console.error('Error reading folder:', folder, err);
      return;
    }

    files.forEach(file => {
      const filePath = path.join(folder, file);
      fs.stat(filePath, (err, stats) => {
        if (err) {
          console.error('Error reading stats:', filePath, err);
          return;
        }

        if (stats.isDirectory()) {
          processFolder(filePath); // Recurse into subfolder
        } else if (file.endsWith('.html')) {
          fs.readFile(filePath, 'utf8', (err, data) => {
            if (err) {
              console.error('Error reading file:', filePath, err);
              return;
            }

            // Generate canonical URL based on filename, ignoring 'tools' folder
            let relativePath = path.relative(htmlFolder, filePath).replace(/\\/g, '/'); // support Windows paths
            let fileName = relativePath.replace('.html', '');
            if (fileName === 'index') fileName = '';
            // Build canonical URL directly under domain
            let canonicalUrl = `${baseUrl}/${fileName}`;
            canonicalUrl = removeTrailingSlash(canonicalUrl);

            // Replace canonical, og:url, twitter:url
            let updatedData = data
              .replace(/<link rel="canonical" href=".*?">/, `<link rel="canonical" href="${canonicalUrl}">`)
              .replace(/<meta property="og:url" content=".*?">/, `<meta property="og:url" content="${canonicalUrl}">`)
              .replace(/<meta property="twitter:url" content=".*?">/, `<meta property="twitter:url" content="${canonicalUrl}">`);

            // Also update JSON-LD @url if exists
            updatedData = updatedData.replace(/"url":\s*".*?"/, `"url": "${canonicalUrl}"`);

            fs.writeFile(filePath, updatedData, 'utf8', err => {
              if (err) {
                console.error('Error writing file:', filePath, err);
              } else {
                console.log('Updated canonical for', filePath);
              }
            });
          });
        }
      });
    });
  });
}

// Start processing
processFolder(htmlFolder);
