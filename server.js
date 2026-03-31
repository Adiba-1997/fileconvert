
const express = require("express");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const multer = require("multer");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const os = require("os");
const { spawn } = require("child_process");
const archiver = require("archiver");
const { v4: uuidv4 } = require("uuid");
const convertersConfig = require("./converters.json");
const sharp = require("sharp");
const AdmZip = require('adm-zip');

const app = express();


// ---------- Security ----------
app.use(helmet({ contentSecurityPolicy: false }));
app.use(rateLimit({ windowMs: 60 * 1000, max: 60 }));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ---------- Serve static frontend ----------
app.use(express.static(path.join(__dirname, "public")));
app.use(express.static(path.join(__dirname, "public/tools")));

// Multer uploads (temporary)
const upload = multer({ 
  dest: path.join(os.tmpdir(), "uploads"),
  limits: {
    fileSize: 100 * 1024 * 1024, // 100MB limit
  }
});

// Helper to run shell commands


// Helper function to get MIME type from extension
function getMimeType(ext) {
  const mimeTypes = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp'
  };
  return mimeTypes[ext.toLowerCase()] || 'application/octet-stream';
}

// Add this helper function for simple markdown conversion
function convertMarkdownSimple(markdown) {
  // Simple regex-based markdown to HTML conversion
  let html = markdown
    // Headers
    .replace(/^# (.*$)/gim, '<h1>$1</h1>')
    .replace(/^## (.*$)/gim, '<h2>$1</h2>')
    .replace(/^### (.*$)/gim, '<h3>$1</h3>')
    .replace(/^#### (.*$)/gim, '<h4>$1</h4>')
    .replace(/^##### (.*$)/gim, '<h5>$1</h5>')
    .replace(/^###### (.*$)/gim, '<h6>$1</h6>')
    
    // Bold and italic
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.*?)\*/g, '<em>$1</em>')
    .replace(/_(.*?)_/g, '<em>$1</em>')
    
    // Links
    .replace(/\[([^\[]+)\]\(([^\)]+)\)/g, '<a href="$2">$1</a>')
    
    // Images
    .replace(/!\[([^\[]+)\]\(([^\)]+)\)/g, '<img src="$2" alt="$1">')
    
    // Code blocks
    .replace(/```([^`]+)```/g, '<pre><code>$1</code></pre>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    
    // Blockquotes
    .replace(/^> (.*$)/gim, '<blockquote>$1</blockquote>')
    
    // Horizontal rules
    .replace(/^\-\-\-$/gim, '<hr>')
    
    // Lists
    .replace(/^\* (.*$)/gim, '<ul><li>$1</li></ul>')
    .replace(/^\- (.*$)/gim, '<ul><li>$1</li></ul>')
    .replace(/^\+ (.*$)/gim, '<ul><li>$1</li></ul>')
    .replace(/^\d+\. (.*$)/gim, '<ol><li>$1</li></ol>')
    
    // Paragraphs
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br>');
  
  // Wrap in HTML structure
  return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Converted Markdown</title>
    <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
               line-height: 1.6; max-width: 800px; margin: 0 auto; padding: 20px; }
        h1, h2, h3, h4, h5, h6 { color: #2c3e50; margin-top: 1.5em; }
        code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; }
        pre { background: #f8f9fa; padding: 15px; border-radius: 5px; overflow: auto; }
        pre code { background: none; padding: 0; }
        blockquote { border-left: 4px solid #ddd; padding-left: 15px; margin-left: 0; color: #666; }
        img { max-width: 100%; height: auto; }
    </style>
</head>
<body>
    <p>${html}</p>
</body>
</html>`;
}


// Helper function for clean file naming
function getCleanOutputName(originalName, suffix = "", newExt = null) {
  const ext = path.extname(originalName);
  const baseName = path.basename(originalName, ext);
  const finalExt = newExt || ext;
  
  // Remove any existing suffixes to avoid duplication
  const cleanBase = baseName.replace(/(_rotated|_converted|_watermarked|-\d+)$/i, '');
  
  return suffix ? `${cleanBase}-${suffix}${finalExt}` : `${cleanBase}${finalExt}`;
}

function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    
    console.log(`Executing: ${cmd} ${args.join(' ')}`);
    
    const proc = spawn(cmd, args, { 
      stdio: ['ignore', 'pipe', 'pipe'], 
      ...options 
    });
    
    proc.stdout.on('data', (data) => {
      stdout += data.toString();
      console.log(`[${cmd} stdout]: ${data.toString().trim()}`);
    });
    
    proc.stderr.on('data', (data) => {
      stderr += data.toString();
      console.log(`[${cmd} stderr]: ${data.toString().trim()}`);
    });
    
    proc.on('error', (error) => {
      console.error(`[${cmd} spawn error]: ${error.message}`);
      error.stderr = stderr;
      error.stdout = stdout;
      reject(error);
    });
    
    proc.on('exit', (code) => {
      if (code === 0) {
        console.log(`[${cmd} completed successfully]`);
        resolve({ stdout, stderr });
      } else {
        const error = new Error(`${cmd} exited with code ${code}`);
        console.error(`[${cmd} failed]: Code ${code}, Stderr: ${stderr}`);
        error.code = code;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

// ==================== OCR HELPER FUNCTIONS ====================

// Helper function for OCR text extraction from scanned PDFs
async function extractTextWithOCR(inp, out) {
  const tempDir = path.join(os.tmpdir(), `ocr_${uuidv4()}`);
  await fsp.mkdir(tempDir, { recursive: true });
  
  try {
    console.log("Starting OCR processing...");
    
    // Step 1: Convert PDF to high-quality images
    console.log("Converting PDF pages to images...");
    await run("pdftoppm", [
      "-png",
      "-r", "300", // 300 DPI for better OCR accuracy
      "-aa", "yes",
      "-aaVector", "yes",
      inp,
      path.join(tempDir, "page")
    ]);
    
    // Find all generated images
    const files = await fsp.readdir(tempDir);
    const imageFiles = files.filter(f => f.endsWith('.png')).sort();
    
    if (imageFiles.length === 0) {
      throw new Error("No pages converted to images");
    }
    
    console.log(`Found ${imageFiles.length} pages to process`);
    
    // Step 2: OCR each page
    const allText = [];
    let processedPages = 0;
    
    for (const imageFile of imageFiles) {
      const imagePath = path.join(tempDir, imageFile);
      const textPath = path.join(tempDir, `text_${path.basename(imageFile, '.png')}.txt`);
      
      console.log(`OCR processing page ${processedPages + 1}: ${imageFile}`);
      
      try {
        // Try multiple OCR approaches for better accuracy
        await run("tesseract", [
          imagePath,
          textPath.replace('.txt', ''),
          "-l", "eng",      // English language
          "--dpi", "300",
          "-c", "preserve_interword_spaces=1",
          "txt"
        ]);
        
        if (fs.existsSync(textPath)) {
          const text = await fsp.readFile(textPath, 'utf8');
          const cleanedText = cleanOCRText(text);
          
          if (cleanedText.trim().length > 0) {
            allText.push(`--- Page ${processedPages + 1} ---`);
            allText.push(cleanedText);
            allText.push(''); // Empty line between pages
            processedPages++;
          }
          
          await fsp.unlink(textPath).catch(() => {});
        }
      } catch (ocrError) {
        console.warn(`OCR failed for page ${processedPages + 1}:`, ocrError.message);
      }
      
      // Clean up image file
      await fsp.unlink(imagePath).catch(() => {});
    }
    
    if (allText.length === 0) {
      throw new Error("OCR processing failed to extract any text");
    }
    
    // Step 3: Combine all text and write to output
    const combinedText = allText.join('\n');
    await fsp.writeFile(out, combinedText, 'utf8');
    
    console.log(`OCR completed: ${processedPages} pages processed, ${combinedText.length} characters extracted`);
    
  } finally {
    // Clean up temporary directory
    await fsp.rm(tempDir, { recursive: true }).catch(() => {});
  }
}

// Helper function to clean and improve OCR text
function cleanOCRText(text) {
  if (!text) return '';
  
  return text
    // Fix common OCR errors
    .replace(/[|]/g, 'I')       // Fix | being misread as I
    .replace(/[0]/g, 'O')       // Fix 0 being misread as O in some contexts
    .replace(/[1l]/g, 'I')      // Fix 1/l being misread as I
    .replace(/\s+/g, ' ')       // Normalize whitespace
    .replace(/(\w)-\s*\n\s*(\w)/g, '$1$2') // Fix hyphenated word breaks
    .replace(/(\n\s*){3,}/g, '\n\n') // Normalize multiple newlines
    .trim();
}

// Alternative Python-based OCR (more accurate)
async function extractTextWithPythonOCR(inp, out) {
  const pythonPath = "/app/pdfenv/bin/python3";
  const scriptPath = path.join(os.tmpdir(), `ocr_pdf_${uuidv4()}.py`);
  
  const pythonScript = `
import sys
import pytesseract
from pdf2image import convert_from_path
import os

def extract_text_with_ocr(pdf_path, output_path):
    try:
        print(f"Converting PDF to images: {pdf_path}")
        
        # Convert PDF to images
        images = convert_from_path(
            pdf_path,
            dpi=300,           # High resolution for better OCR
            poppler_path=None   # Use system poppler
        )
        
        print(f"Converted {len(images)} pages to images")
        
        all_text = []
        
        for i, image in enumerate(images):
            print(f"OCR processing page {i+1}...")
            
            # OCR with optimized settings
            text = pytesseract.image_to_string(
                image,
                lang='eng',           # English
                config='--dpi 300 --psm 6 -c preserve_interword_spaces=1'
            )
            
            if text.strip():
                # Clean the text
                text = text.replace('\\x0c', '')  # Remove form feeds
                text = ' '.join(text.split())     # Normalize whitespace
                
                all_text.append(f"--- Page {i+1} ---")
                allText.append(text)
                all_text.append('')  # Empty line between pages
                
                print(f"Page {i+1}: Extracted {len(text)} characters")
            else:
                print(f"Page {i+1}: No text found")
        
        if not all_text:
            return False, "No text could be extracted from any page"
        
        # Write to output file
        with open(output_path, 'w', encoding='utf-8') as f:
            f.write('\\n'.join(all_text))
        
        return True, f"Successfully extracted text from {len(images)} pages"
        
    except Exception as e:
        return False, f"OCR processing failed: {str(e)}"

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("ERROR: Usage: python script.py <input.pdf> <output.txt>")
        sys.exit(1)
    
    pdf_path = sys.argv[1]
    output_path = sys.argv[2]
    
    success, message = extract_text_with_ocr(pdf_path, output_path)
    
    if success:
        print("SUCCESS:" + message)
        sys.exit(0)
    else:
        print("ERROR:" + message)
        sys.exit(1)
`;
  
  try {
    await fsp.writeFile(scriptPath, pythonScript);
    
    const { stdout, stderr } = await run(pythonPath, [scriptPath, inp, out]);
    
    if (stdout.includes("ERROR:")) {
      throw new Error(stdout.split("ERROR:")[1].trim());
    }
    
    if (!fs.existsSync(out)) {
      throw new Error("Python OCR did not create output file");
    }
    
    console.log("Python OCR completed successfully");
    
  } finally {
    await fsp.unlink(scriptPath).catch(() => {});
  }
}

// ==================== OCR IMAGE TO EXCEL HELPER FUNCTIONS ====================

// Helper function for OCR image to Excel conversion
async function extractTableFromImageToExcel(inp, out) {
  const pythonPath = "/app/pdfenv/bin/python3";
  const scriptPath = path.join(os.tmpdir(), `img_to_excel_${uuidv4()}.py`);
  
  const pythonScript = `
import sys
import cv2
import pytesseract
import pandas as pd
import numpy as np
from PIL import Image
import re

def preprocess_image(image_path):
    """Preprocess image for better OCR accuracy"""
    try:
        # Read image
        img = cv2.imread(image_path)
        if img is None:
            raise ValueError("Could not read image file")
        
        # Convert to grayscale
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        
        # Apply noise reduction
        denoised = cv2.medianBlur(gray, 3)
        
        # Apply thresholding
        _, thresh = cv2.threshold(denoised, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        
        # Morphological operations to clean up the image
        kernel = np.ones((1, 1), np.uint8)
        processed = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, kernel)
        
        return processed
    except Exception as e:
        print(f"Image preprocessing failed: {e}")
        # Return original image if preprocessing fails
        return cv2.imread(image_path, cv2.IMREAD_GRAYSCALE)

def detect_table_structure(image):
    """Detect table structure in image"""
    try:
        # Detect horizontal lines
        horizontal_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (25, 1))
        detect_horizontal = cv2.morphologyEx(image, cv2.MORPH_OPEN, horizontal_kernel, iterations=2)
        
        # Detect vertical lines
        vertical_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, 25))
        detect_vertical = cv2.morphologyEx(image, cv2.MORPH_OPEN, vertical_kernel, iterations=2)
        
        # Combine horizontal and vertical lines
        table_structure = cv2.addWeighted(detect_horizontal, 0.5, detect_vertical, 0.5, 0.0)
        
        return table_structure
    except Exception as e:
        print(f"Table detection failed: {e}")
        return None

def extract_table_data(image_path):
    """Extract tabular data from image using OCR"""
    try:
        # Preprocess image
        processed_img = preprocess_image(image_path)
        
        # Try multiple OCR configurations for table extraction
        configurations = [
            '--psm 6 -c tessedit_char_whitelist=0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz.,$-:/ ()',  # Uniform block of text
            '--psm 4',  # Assume a single column of text of variable sizes
            '--psm 3',  # Fully automatic page segmentation, but no OSD (Default)
        ]
        
        best_data = None
        max_cells = 0
        
        for config in configurations:
            try:
                # Extract data using OCR
                data = pytesseract.image_to_data(
                    processed_img,
                    config=config,
                    output_type=pytesseract.Output.DICT
                )
                
                # Count number of cells with confidence > 30
                confident_cells = sum(1 for conf in data['conf'] if int(conf) > 30)
                
                if confident_cells > max_cells:
                    max_cells = confident_cells
                    best_data = data
                    
            except Exception as e:
                print(f"OCR config failed: {config}, error: {e}")
                continue
        
        if not best_data:
            # Fallback to basic OCR
            best_data = pytesseract.image_to_data(processed_img, output_type=pytesseract.Output.DICT)
        
        return best_data
        
    except Exception as e:
        print(f"Table extraction failed: {e}")
        return None

def organize_table_data(ocr_data):
    """Organize OCR data into table structure"""
    try:
        n_boxes = len(ocr_data['text'])
        cells = []
        
        for i in range(n_boxes):
            text = ocr_data['text'][i].strip()
            conf = int(ocr_data['conf'][i])
            
            # Only consider confident detections and non-empty text
            if conf > 30 and text:
                x = ocr_data['left'][i]
                y = ocr_data['top'][i]
                w = ocr_data['width'][i]
                h = ocr_data['height'][i]
                
                cells.append({
                    'text': text,
                    'x': x,
                    'y': y,
                    'width': w,
                    'height': h,
                    'conf': conf
                })
        
        if not cells:
            return None
        
        # Sort cells by y-coordinate (rows), then by x-coordinate (columns)
        cells.sort(key=lambda cell: (cell['y'], cell['x']))
        
        # Group cells into rows based on y-coordinate proximity
        rows = []
        current_row = [cells[0]]
        row_threshold = cells[0]['height'] * 0.8  # 80% of cell height as threshold
        
        for cell in cells[1:]:
            if abs(cell['y'] - current_row[0]['y']) <= row_threshold:
                current_row.append(cell)
            else:
                # Sort current row by x-coordinate
                current_row.sort(key=lambda c: c['x'])
                rows.append(current_row)
                current_row = [cell]
        
        # Add the last row
        if current_row:
            current_row.sort(key=lambda c: c['x'])
            rows.append(current_row)
        
        # Create DataFrame
        max_cols = max(len(row) for row in rows) if rows else 0
        
        table_data = []
        for row in rows:
            row_data = [cell['text'] for cell in row]
            # Pad row with empty strings if needed
            while len(row_data) < max_cols:
                row_data.append('')
            table_data.append(row_data)
        
        return table_data
        
    except Exception as e:
        print(f"Data organization failed: {e}")
        return None

def image_to_excel(image_path, output_path):
    """Main function to convert image table to Excel"""
    try:
        print(f"Processing image: {image_path}")
        
        # Extract OCR data
        ocr_data = extract_table_data(image_path)
        if not ocr_data:
            return False, "Failed to extract data from image"
        
        # Organize into table structure
        table_data = organize_table_data(ocr_data)
        
        if not table_data:
            return False, "No table structure detected in image"
        
        print(f"Detected table with {len(table_data)} rows and {len(table_data[0]) if table_data else 0} columns")
        
        # Create DataFrame and save to Excel
        df = pd.DataFrame(table_data)
        
        # Clean the data
        df = df.replace(['', ' ', '  ', '  '], np.nan)
        df = df.dropna(how='all').reset_index(drop=True)  # Remove empty rows
        df = df.loc[:, ~df.isnull().all()]  # Remove empty columns
        
        if df.empty:
            return False, "No valid data found after cleaning"
        
        # Save to Excel
        with pd.ExcelWriter(output_path, engine='openpyxl') as writer:
            df.to_excel(writer, sheet_name='Extracted_Data', index=False, header=False)
            
            # Auto-adjust column widths
            worksheet = writer.sheets['Extracted_Data']
            for column in worksheet.columns:
                max_length = 0
                column_letter = column[0].column_letter
                for cell in column:
                    try:
                        if len(str(cell.value)) > max_length:
                            max_length = len(str(cell.value))
                    except:
                        pass
                adjusted_width = min(max_length + 2, 50)
                worksheet.column_dimensions[column_letter].width = adjusted_width
        
        print(f"Successfully created Excel file with {len(df)} rows and {len(df.columns)} columns")
        return True, f"Extracted {len(df)} rows and {len(df.columns)} columns"
        
    except Exception as e:
        return False, f"Conversion failed: {str(e)}"

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("ERROR: Usage: python script.py <input_image> <output_excel>")
        sys.exit(1)
    
    input_image = sys.argv[1]
    output_excel = sys.argv[2]
    
    success, message = image_to_excel(input_image, output_excel)
    
    if success:
        print("SUCCESS:" + message)
        sys.exit(0)
    else:
        print("ERROR:" + message)
        sys.exit(1)
`;
  
  try {
    await fsp.writeFile(scriptPath, pythonScript);
    
    const { stdout, stderr } = await run(pythonPath, [scriptPath, inp, out]);
    
    if (stdout.includes("ERROR:")) {
      throw new Error(stdout.split("ERROR:")[1].trim());
    }
    
    if (!fs.existsSync(out)) {
      throw new Error("Excel file was not created");
    }
    
    console.log("OCR Image to Excel completed successfully");
    
  } finally {
    await fsp.unlink(scriptPath).catch(() => {});
  }
}

// Zip multiple files and send
async function sendZip(res, files, zipName = "converted.zip") {
  const zipPath = path.join(os.tmpdir(), `${uuidv4()}.zip`);
  const output = fs.createWriteStream(zipPath);
  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.pipe(output);
  for (const f of files) archive.file(f.path, { name: f.name });
  await archive.finalize();
  output.on("close", async () => {
    res.download(zipPath, zipName, async () => {
      await fsp.unlink(zipPath).catch(() => {});
      for (const f of files) await fsp.unlink(f.path).catch(() => {});
    });
  });
}
async function processImageToWordSimple(inp, out, language) {
  try {
      // Direct Tesseract to DOCX
      await run("tesseract", [
          inp,
          out.replace('.docx', ''),
          "-l", language,
          "docx"
      ]);
      
      // Check if output was created with .docx extension
      const possibleOut = out.replace('.docx', '') + '.docx';
      if (fs.existsSync(possibleOut) && possibleOut !== out) {
          await fsp.rename(possibleOut, out);
      }
      
      return true;
  } catch (error) {
      console.log("Simple conversion failed:", error.message);
      return false;
  }
}

async function directPdfToDocx(inp, out, pythonPath) {
    try {
        const pythonScript = `
from pdf2docx import Converter
import docx

def convert_pdf_to_docx(input_pdf, output_docx):
    try:
        cv = Converter(input_pdf)
        cv.convert(output_docx)
        cv.close()
        
        # Check if document has content
        doc = docx.Document(output_docx)
        word_count = sum(len(p.text.split()) for p in doc.paragraphs)
        
        if word_count > 0:
            print(f"Direct conversion successful: {word_count} words")
            return True
        else:
            print("Direct conversion produced empty document")
            return False
            
    except Exception as e:
        print(f"Direct conversion failed: {e}")
        return False

if __name__ == "__main__":
    success = convert_pdf_to_docx("${inp}", "${out}")
    if not success:
        exit(1)
`;

        const scriptPath = path.join(os.tmpdir(), `direct_convert_${uuidv4()}.py`);
        await fsp.writeFile(scriptPath, pythonScript);
        await run(pythonPath, [scriptPath]);
        
        // Verify the output has content
        const stats = await fsp.stat(out);
        return stats && stats.size > 1024;
        
    } catch (error) {
        console.log("Direct conversion attempt failed:", error.message);
        return false;
    }
}

async function processScannedPdf(inp, out, tempDir, pythonPath) {
    // Step 1: Use ocrmypdf to create searchable PDF
    const searchablePdf = path.join(tempDir, "searchable.pdf");
    
    console.log("Creating searchable PDF with OCR...");
    await run("ocrmypdf", [
        "--force-ocr",
        "--language", "eng",
        "--output-type", "pdf",
        "--deskew",
        "--clean",
        inp,
        searchablePdf
    ]);

    // Step 2: Extract text from searchable PDF
    const extractedText = path.join(tempDir, "content.txt");
    console.log("Extracting text from searchable PDF...");
    await run("pdftotext", [
        "-layout",
        "-enc", "UTF-8",
        searchablePdf,
        extractedText
    ]);

    // Step 3: Create Word document from extracted text
    const pythonScript = `
from docx import Document
import re

def create_word_from_text(text_file, output_docx):
    # Read extracted text
    with open(text_file, 'r', encoding='utf-8', errors='ignore') as f:
        content = f.read()
    
    # Clean and format the text
    content = re.sub(r'\\\\s+', ' ', content)
    content = re.sub(r'(\\\\n\\\\s*){3,}', '\\\\n\\\\n', content)
    
    # Create document
    doc = Document()
    
    # Split into paragraphs and add to document
    paragraphs = [p.strip() for p in content.split('\\\\n\\\\n') if p.strip()]
    
    for paragraph in paragraphs:
        if paragraph:
            doc.add_paragraph(paragraph)
    
    doc.save(output_docx)
    print(f"Created Word document with {len(paragraphs)} paragraphs")

if __name__ == "__main__":
    create_word_from_text("${extractedText}", "${out}")
`;

    const scriptPath = path.join(tempDir, "create_docx.py");
    await fsp.writeFile(scriptPath, pythonScript);
    await run(pythonPath, [scriptPath]);

    // Final verification
    const stats = await fsp.stat(out);
    if (!stats || stats.size === 0) {
        throw new Error("OCR processing failed - empty Word document");
    }
}


// Helper function for direct Tesseract OCR
async function directTesseractOcr(inp, out, tempDir) {
    // Convert PDF to images
    await run("pdftoppm", [
        "-png",
        "-r", "300",
        inp,
        path.join(tempDir, "page")
    ]);

    // Find all generated images
    const files = await fsp.readdir(tempDir);
    const imageFiles = files.filter(f => f.endsWith('.png')).sort();
    
    if (imageFiles.length === 0) {
        throw new Error("No pages converted to images");
    }

    // OCR each page
    const allText = [];
    for (const imageFile of imageFiles) {
        const imagePath = path.join(tempDir, imageFile);
        const textPath = path.join(tempDir, `text_${imageFile}.txt`);
        
        await run("tesseract", [
            imagePath,
            textPath.replace('.txt', ''),
            "-l", "eng",
            "txt"
        ]);

        if (fs.existsSync(textPath)) {
            const text = await fsp.readFile(textPath, 'utf8');
            allText.push(text);
            await fsp.unlink(textPath).catch(() => {});
        }
        await fsp.unlink(imagePath).catch(() => {});
    }

    // Create simple text file
    const combinedText = allText.join('\n\n');
    const textOutput = out.replace('.docx', '.txt');
    await fsp.writeFile(textOutput, combinedText);
    
    // Convert text to Word
    const pythonScript = `
from docx import Document

with open("${textOutput}", "r", encoding="utf-8", errors="ignore") as f:
    content = f.read()

doc = Document()
doc.add_heading("OCR Extracted Text", level=1)

if content.strip():
    paragraphs = [p.strip() for p in content.split('\\n\\n') if p.strip()]
    for para in paragraphs:
        if para:
            doc.add_paragraph(para)
else:
    doc.add_paragraph("No text could be extracted using Tesseract OCR.")

doc.save("${out}")
`;
    const scriptPath = path.join(tempDir, "tesseract_to_docx.py");
    await fsp.writeFile(scriptPath, pythonScript);
    
    const pythonPath = "/app/pdfenv/bin/python3";
    await run(pythonPath, [scriptPath]);
    
    await fsp.unlink(textOutput).catch(() => {});
}

// Helper function for basic text extraction
async function basicTextExtraction(inp, out, tempDir, pythonPath) {
    const textOutput = path.join(tempDir, "raw_text.txt");
    
    // Try pdftotext
    await run("pdftotext", [
        "-layout",
        "-enc", "UTF-8",
        inp,
        textOutput
    ]);

    // Create Word document
    const pythonScript = `
from docx import Document

try:
    with open("${textOutput}", "r", encoding="utf-8", errors="ignore") as f:
        content = f.read()
except:
    content = ""

doc = Document()
doc.add_heading("Text Extraction Results", level=1)

if content.strip():
    doc.add_paragraph("The following text was extracted from the PDF:")
    doc.add_paragraph("---")
    
    paragraphs = [p.strip() for p in content.split('\\n\\n') if p.strip()]
    for para in paragraphs[:50]:  # Limit to first 50 paragraphs
        doc.add_paragraph(para)
        
    if len(paragraphs) > 50:
        doc.add_paragraph(f"... and {len(paragraphs) - 50} more paragraphs")
else:
    doc.add_paragraph("No text could be extracted from the PDF.")
    doc.add_paragraph("This could indicate:")
    doc.add_paragraph("- The PDF is image-based (scanned)")
    doc.add_paragraph("- The PDF is password protected")
    doc.add_paragraph("- The PDF is corrupted")

doc.save("${out}")
`;
    const scriptPath = path.join(tempDir, "basic_docx.py");
    await fsp.writeFile(scriptPath, pythonScript);
    await run(pythonPath, [scriptPath]);
}

// Helper function to create error document
async function createErrorDocument(errorMessage, out, pythonPath) {
    const errorScript = `
from docx import Document

doc = Document()
doc.add_heading("Conversion Report", level=1)
doc.add_paragraph("The PDF conversion encountered an issue.")

# Add specific error information
error_msg = "${errorMessage.replace(/"/g, '\\"')}"
if "password" in error_msg.lower():
    doc.add_paragraph("🔒 Issue: The PDF appears to be password protected.")
    doc.add_paragraph("Please remove the password and try again.")
elif "corrupt" in error_msg.lower():
    doc.add_paragraph("⚠️ Issue: The PDF file may be corrupted.")
    doc.add_paragraph("Please try with a different PDF file.")
else:
    doc.add_paragraph(f"Error details: {error_msg}")

doc.add_paragraph("Possible solutions:")
solutions = doc.add_paragraph()
solutions.add_run("1. ").bold = True
solutions.add_run("Ensure the PDF is not password protected")
solutions = doc.add_paragraph()
solutions.add_run("2. ").bold = True
solutions.add_run("Try a higher quality PDF file")
solutions = doc.add_paragraph()
solutions.add_run("3. ").bold = True
solutions.add_run("Check if the PDF contains selectable text")
solutions = doc.add_paragraph()
solutions.add_run("4. ").bold = True
solutions.add_run("Contact support if the issue persists")

doc.add_paragraph("\\nThank you for using FileConvert!")
doc.save("${out}")
`;
    
    const scriptPath = path.join(os.tmpdir(), `error_doc_${uuidv4()}.py`);
    await fsp.writeFile(scriptPath, errorScript);
    await run(pythonPath, [scriptPath]);
}

// Helper function to extract text and create Word doc
async function extractAndCreateWord(pdfPath, outPath, tempDir, pythonPath) {
    const extractedText = path.join(tempDir, "content.txt");
    
    await run("pdftotext", [
        "-layout",
        "-enc", "UTF-8",
        pdfPath,
        extractedText
    ]);

    const wordScript = `
from docx import Document

with open("${extractedText}", "r", encoding="utf-8", errors="ignore") as f:
    content = f.read()

doc = Document()
if content.strip():
    paragraphs = [p.strip() for p in content.split('\\n\\n') if p.strip()]
    for para in paragraphs:
        doc.add_paragraph(para)
else:
    doc.add_paragraph("Text extraction completed but no content was found.")

doc.save("${outPath}")
`;
    const scriptPath = path.join(tempDir, "extract_docx.py");
    await fsp.writeFile(scriptPath, wordScript);
    await run(pythonPath, [scriptPath]);
}
// ==================== ENHANCED OCR HELPER FUNCTIONS ====================

async function enhanceScannedPdf(inp, tempDir) {
    // Pre-process images for better OCR
    const enhancedPdf = path.join(tempDir, "enhanced.pdf");
    
    await run("convert", [
        "-density", "300",
        "-colorspace", "Gray",
        "-normalize",
        "-contrast-stretch", "1%",
        "-sharpen", "0x1",
        "-despeckle",
        inp,
        enhancedPdf
    ]);
    
    return enhancedPdf;
}

async function processScannedPdfHighAccuracy(inp, out, tempDir, pythonPath) {
    console.log("Running high-accuracy OCR...");
    
    // Step 1: Pre-process PDF
    const enhancedPdf = await enhanceScannedPdf(inp, tempDir);
    
    // Step 2: Try multiple language models
    const languages = ["eng", "eng_best", "osd", "script-latn"];
    let lastError = null;
    
    for (const lang of languages) {
        try {
            const searchablePdf = path.join(tempDir, `searchable_${lang}.pdf`);
            
            await run("ocrmypdf", [
                "--force-ocr",
                "--language", lang,
                "--output-type", "pdf",
                "--deskew",
                "--clean",
                "--clean-final",
                "--pdf-renderer", "hocr",
                "--rotate-pages",
                "--tesseract-oem", "1",
                "--tesseract-pagesegmode", "6",
                "--tesseract-timeout", "300",
                enhancedPdf,
                searchablePdf
            ]);

            // Step 3: Extract text
            const extractedText = path.join(tempDir, "content.txt");
            await run("pdftotext", [
                "-layout", "-enc", "UTF-8", "-eol", "unix", "-nopgbrk", "-r", "300",
                searchablePdf,
                extractedText
            ]);

            // Step 4: Create Word document with post-processing
            const wordScript = `
from docx import Document
import re

def enhance_ocr_accuracy(text):
    corrections = {
        '|': 'I', '[]': '', '0': 'O', '1': 'I', '5': 'S', 
        '€': 'C', '¢': 'c', '£': 'E', '¥': 'Y',
        ' teh ': ' the ', ' adn ': ' and ', ' tne ': ' the ',
        ' wi11 ': ' will ', ' vv ': ' w ', ' vvith ': ' with ',
    }
    
    for wrong, right in corrections.items():
        text = text.replace(wrong, right)
    
    text = re.sub(r'(\\w)(\\s+)(\\w)', lambda m: m.group(1) + m.group(3) if len(m.group(2)) < 3 else m.group(0), text)
    text = re.sub(r'(\\w)-\\s*\\n\\s*(\\w)', '\\1\\2', text)
    
    return text

def create_high_accuracy_doc(text_file, output_docx):
    content = ""
    for encoding in ['utf-8', 'latin-1', 'windows-1252']:
        try:
            with open(text_file, 'r', encoding=encoding, errors='replace') as f:
                content = f.read()
            break
        except UnicodeDecodeError:
            continue
    
    content = enhance_ocr_accuracy(content)
    content = re.sub(r'[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]', '', content)
    content = re.sub(r'\\s+', ' ', content)
    content = re.sub(r'\\n\\s*\\n', '\\n\\n', content)
    
    doc = Document()
    paragraphs = [p.strip() for p in content.split('\\n\\n') if p.strip()]
    
    for paragraph in paragraphs:
        if len(paragraph) > 2:
            doc.add_paragraph(paragraph)
    
    if len(doc.paragraphs) < 3:
        doc.add_paragraph("Note: For better OCR accuracy, use 300+ DPI scans with clear text.")
    
    doc.save(output_docx)

if __name__ == "__main__":
    create_high_accuracy_doc("${extractedText}", "${out}")
`;

            const scriptPath = path.join(tempDir, "high_accuracy_docx.py");
            await fsp.writeFile(scriptPath, wordScript);
            await run(pythonPath, [scriptPath]);
            
            console.log(`Success with language: ${lang}`);
            return;
            
        } catch (error) {
            lastError = error;
            console.log(`Failed with language ${lang}:`, error.message);
            continue;
        }
    }
    
    throw new Error(`All language models failed: ${lastError?.message}`);
}


// Converter functions
const converters = {
  // Document Converters
  "word-to-pdf": async (inp, out) => {
    await run("soffice", ["--headless", "--convert-to", "pdf", inp, "--outdir", path.dirname(out)]);
    const gen = path.join(path.dirname(out), path.basename(inp, path.extname(inp)) + ".pdf");
    await fsp.rename(gen, out);
  },

  "pdf-to-word": async (inputPath, outputPath) => {
    const pythonPath = "/app/pdfenv/bin/python3";
    const outputDir = path.dirname(outputPath);
    
    try {
        // First try LibreOffice
        await run("soffice", [
            "--headless",
            "--convert-to", "docx",
            inputPath,
            "--outdir", outputDir
        ]);
        
        // Check for LibreOffice output
        const libreOutput = path.join(
            outputDir,
            path.basename(inputPath, path.extname(inputPath)) + ".docx"
        );
        
        if (fs.existsSync(libreOutput)) {
            await fsp.rename(libreOutput, outputPath);
            console.log("PDF → Word succeeded via LibreOffice");
            return outputPath;
        }
    } catch (libreError) {
        console.warn("LibreOffice conversion failed, falling back to pdf2docx:", libreError.message);
    }

    // Fallback to pdf2docx in virtualenv
    try {
        console.log(`Attempting PDF → Word conversion with ${pythonPath}`);
        
        await run(pythonPath, [
            "-c",
            `from pdf2docx import Converter; ` +
            `cv = Converter("${inputPath}"); ` +
            `cv.convert("${outputPath}", start=0, end=None); ` +
            `cv.close()`
        ]);

        if (!fs.existsSync(outputPath)) {
            throw new Error("Conversion completed but output file not found");
        }

        console.log("PDF → Word succeeded via pdf2docx");
        return outputPath;
    } catch (pdf2docxError) {
        console.error("PDF → Word conversion failed:", pdf2docxError);
        
        // Clean up any partial output
        if (fs.existsSync(outputPath)) {
            await fsp.unlink(outputPath).catch(() => {});
        }
        
        throw new Error(`PDF to Word conversion failed: ${pdf2docxError.message}`);
    }
  },

"pdf-to-text": async (inp, out) => {
  try {
    console.log(`Converting PDF to Text: ${inp} -> ${out}`);
    
    // Check if input file exists
    if (!fs.existsSync(inp)) {
      throw new Error("Input PDF file not found");
    }
    
    // Ensure output has .txt extension
    if (!out.toLowerCase().endsWith('.txt')) {
      out = out + '.txt';
    }
    
    // Step 1: First try regular text extraction
    console.log("Attempting regular text extraction...");
    await run("pdftotext", [
      "-layout",        // Maintain layout
      "-enc", "UTF-8",  // UTF-8 encoding
      "-eol", "unix",   // Unix line endings
      inp,
      out
    ]);
    
    // Check if we got meaningful content
    let hasContent = false;
    if (fs.existsSync(out)) {
      const content = await fsp.readFile(out, 'utf8');
      const text = content.replace(/\s+/g, ' ').trim();
      
      // Check if we have substantial text (more than just a few characters)
      if (text.length > 50) {
        console.log(`Regular extraction successful: ${text.length} characters`);
        hasContent = true;
      } else {
        console.log(`Regular extraction produced minimal content: ${text.length} characters`);
        await fsp.unlink(out).catch(() => {});
      }
    }
    
    // Step 2: If regular extraction failed, try OCR
    if (!hasContent) {
      console.log("Regular extraction failed, attempting OCR...");
      await extractTextWithOCR(inp, out);
    }
    
    // Final verification
    const stats = await fsp.stat(out);
    if (!stats || stats.size === 0) {
      throw new Error("Text extraction failed - no content could be extracted");
    }
    
    console.log(`Text extracted successfully: ${stats.size} bytes`);
    return out;
    
  } catch (error) {
    console.error("PDF to Text conversion failed:", error);
    
    // Create error file with helpful message
    const errorMessage = `PDF to Text conversion failed.

Error: ${error.message}

Possible reasons:
1. The PDF is image-based (scanned document) - try OCR tools
2. The PDF is password protected
3. The PDF is corrupted
4. The PDF contains no extractable text

Solutions:
- For scanned PDFs, use OCR tools
- Ensure the PDF is not password protected
- Try a different PDF file`;

    await fsp.writeFile(out, errorMessage);
    return out;
  }
},

  "excel-to-csv": async (inp, out) => {
    await run("soffice", [
        "--headless",
        "--convert-to", "csv",
        inp,
        "--outdir", path.dirname(out)
    ]);
    const gen = path.join(path.dirname(out), path.basename(inp, path.extname(inp)) + ".csv");
    await fsp.rename(gen, out);
  },

  "convert-epub-to-mobi": async (inp, out) => {
    try {
      console.log(`Converting EPUB to MOBI: ${inp} -> ${out}`);
      
      // Check if input file exists
      if (!fs.existsSync(inp)) {
        throw new Error("Input EPUB file not found");
      }
      
      // Ensure output has .mobi extension
      if (!out.toLowerCase().endsWith('.mobi')) {
        out = out + '.mobi';
      }
      
      // Create a temporary file with .epub extension for ebook-convert
      const tempEpubPath = path.join(os.tmpdir(), `${uuidv4()}.epub`);
      await fsp.copyFile(inp, tempEpubPath);
      
      console.log(`Using temporary EPUB file: ${tempEpubPath}`);
      
      // Use ebook-convert from Calibre
      await run("ebook-convert", [
        tempEpubPath,
        out
      ]);
      
      // Clean up temporary file
      await fsp.unlink(tempEpubPath).catch(() => {});
      
      // Verify the output was created
      const stats = await fsp.stat(out);
      if (!stats || stats.size === 0) {
        throw new Error("MOBI conversion failed - output file is empty");
      }
      
      console.log(`MOBI created successfully: ${stats.size} bytes`);
      return out;
      
    } catch (error) {
      console.error("EPUB to MOBI conversion failed:", error);
      
      // Fallback: Try Python-based conversion
      try {
        console.log("Trying Python fallback for EPUB to MOBI...");
        const pythonPath = "/app/pdfenv/bin/python3";
        
        const pythonScript = `
  import sys
  import os
  import tempfile
  import subprocess
  
  def convert_epub_to_mobi(input_path, output_path):
      try:
          # Check if input exists
          if not os.path.exists(input_path):
              return False, "Input file does not exist"
          
          # Use ebook-convert with proper file extensions
          result = subprocess.run([
              "ebook-convert", 
              input_path, 
              output_path
          ], capture_output=True, text=True, timeout=300)
          
          if result.returncode == 0:
              if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
                  return True, "Conversion successful"
              else:
                  return False, "Output file was not created"
          else:
              return False, f"Conversion failed: {result.stderr}"
              
      except Exception as e:
          return False, f"Error: {str(e)}"
  
  if __name__ == "__main__":
      if len(sys.argv) != 3:
          print("ERROR: Usage: python_script.py <input> <output>")
          sys.exit(1)
      
      success, message = convert_epub_to_mobi(sys.argv[1], sys.argv[2])
      if success:
          print("SUCCESS:" + message)
      else:
          print("ERROR:" + message)
          sys.exit(1)
  `;
        
        const scriptPath = path.join(os.tmpdir(), `epub_to_mobi_${uuidv4()}.py`);
        await fsp.writeFile(scriptPath, pythonScript);
        
        // Create temporary files with proper extensions
        const tempEpubPath = path.join(os.tmpdir(), `${uuidv4()}.epub`);
        const tempMobiPath = path.join(os.tmpdir(), `${uuidv4()}.mobi`);
        
        await fsp.copyFile(inp, tempEpubPath);
        
        const { stdout, stderr } = await run(pythonPath, [
          scriptPath,
          tempEpubPath,
          tempMobiPath
        ]);
        
        // Clean up temporary files
        await fsp.unlink(scriptPath).catch(() => {});
        await fsp.unlink(tempEpubPath).catch(() => {});
        
        if (stdout.includes("SUCCESS:")) {
          await fsp.rename(tempMobiPath, out);
          console.log("EPUB to MOBI succeeded via Python fallback");
          return out;
        } else {
          await fsp.unlink(tempMobiPath).catch(() => {});
          throw new Error(stdout.includes("ERROR:") ? stdout.split("ERROR:")[1].trim() : "Python conversion failed");
        }
        
      } catch (fallbackError) {
        console.error("Python fallback also failed:", fallbackError);
      }
      
      throw new Error(`Failed to convert EPUB to MOBI: ${error.message}`);
    }
  },

  "heic-to-jpg": async (inp, out) => {
    await run("convert", [
        inp,
        "-quality", "90%",
        out
    ]);
  },

  "html-to-pdf": async (inp, out) => {
    try {
      console.log(`Converting HTML to PDF using Python: ${inp}`);
      
      const pythonPath = "/app/pdfenv/bin/python3";
      const scriptPath = path.join(__dirname, "html_to_pdf.py");
      
      // Run Python script
      const { stdout, stderr } = await run(pythonPath, [
        scriptPath,
        inp,
        out
      ]);
      
      console.log("Python output:", stdout);
      
      if (stdout.includes("SUCCESS:")) {
        const stats = await fsp.stat(out);
        if (stats && stats.size > 0) {
          console.log("HTML to PDF succeeded via Python");
          return out;
        }
      }
      
      // If Python fails, try system tools as fallback
      console.log("Python conversion failed, trying system tools...");
      
      try {
        await run("wkhtmltopdf", [
          "--enable-local-file-access",
          "--quiet",
          inp,
          out
        ]);
        
        const stats = await fsp.stat(out);
        if (stats && stats.size > 0) {
          console.log("HTML to PDF succeeded via wkhtmltopdf fallback");
          return out;
        }
      } catch (fallbackError) {
        console.log("Fallback also failed:", fallbackError.message);
      }
      
      throw new Error("All HTML to PDF conversion methods failed");
      
    } catch (error) {
      console.error("HTML to PDF conversion failed:", error);
      throw new Error(`HTML to PDF conversion failed: ${error.message}`);
    }
  },

// Alternative PPT to SVG converter using Python
"ppt-to-svg": async (inp, out) => {
  const scriptPath = path.join(process.cwd(), "ppt_to_svg.py");
  const pythonPath = "/app/pdfenv/bin/python3";
  
  return new Promise((resolve, reject) => {
    // Validate input file
    if (!inp || !fs.existsSync(inp)) {
      return reject(new Error("Input file does not exist"));
    }

    // Generate output filename if not provided
    if (!out) {
      const baseName = path.basename(inp, path.extname(inp));
      out = path.join(path.dirname(inp), `${baseName}.svg`);
    }

    // Execute Python script
    const pythonProcess = spawn(pythonPath, [scriptPath, inp, out]);
    
    let stdout = "";
    let stderr = "";

    pythonProcess.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    pythonProcess.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    pythonProcess.on("close", (code) => {
      if (code === 0) {
        console.log("PPT to SVG conversion successful");
        resolve(out);
      } else {
        console.error("PPT to SVG conversion failed");
        reject(new Error(`Conversion failed with code ${code}: ${stderr}`));
      }
    });

    pythonProcess.on("error", (err) => {
      console.error("Failed to start Python process:", err);
      reject(new Error("Failed to start conversion process"));
    });
  });
},

// Add to your converters configuration
"add-page-numbers": async (inp, out, options) => {
  const scriptPath = path.join(process.cwd(), "pdf_numbering.py");
  const pythonPath = "/app/pdfenv/bin/python3";

  // Generate output path if not provided
  if (!out) {
    const baseName = path.basename(inp, path.extname(inp));
    out = path.join(path.dirname(inp), `${baseName}_numbered.pdf`);
  }

  const args = [
    scriptPath,
    inp,
    out,
    options?.position || "bottom-center",
    String(options?.startNum || 1),
    options?.format || "number",
    String(options?.fontSize || 12)
  ];

  // Run Python
  await run(pythonPath, args);

  if (!fs.existsSync(out)) {
    throw new Error("Page numbering process failed: no output file created");
  }

  return out;
},


// Add to your converters configuration
"pdf-add-bookmarks": async (inp, out, options) => {
  const scriptPath = path.join(process.cwd(), "pdf_auto_bookmarks.py");
  const pythonPath = "/app/pdfenv/bin/python3";

  if (!out) {
    const baseName = path.basename(inp, path.extname(inp));
    out = path.join(path.dirname(inp), `${baseName}_with_bookmarks.pdf`);
  }

  const args = [
    scriptPath,
    inp,
    out,
    options?.headingLevel || "all",
    String(options?.maxDepth || 3)
  ];

  try {
    await run(pythonPath, args);
    
    if (!fs.existsSync(out)) {
      throw new Error("Auto-bookmarks process failed: no output file created");
    }

    return out;
  } catch (error) {
    console.error("Python script error:", error);
    throw new Error(`Bookmark generation failed: ${error.message}`);
  }
},


// Add to your converters configuration
"sign-pdf": async (inp, out, options) => {
  const scriptPath = path.join(process.cwd(), "sign_pdf.py");
  const pythonPath = "/app/pdfenv/bin/python3";

  // Generate output path if not provided
  if (!out) {
    const baseName = path.basename(inp, path.extname(inp));
    out = path.join(path.dirname(inp), `${baseName}_signed.pdf`);
  }

  const args = [
    scriptPath,
    inp,
    out,
    options?.sigType || "draw",
    options?.signatureData || "",
    options?.typedSignature || "",
    options?.signatureFont || "arial",
    options?.signaturePosition || "bottom-right",
    String(options?.pageNumber || 1)
  ];

  if (options?.signatureImage) {
    args.push(options.signatureImage);
  }

  // Run Python
  await run(pythonPath, args);

  if (!fs.existsSync(out)) {
    throw new Error("Signature process failed: no output file created");
  }

  return out;
},


// Add to your converters configuration
"heic-to-png": async (inp, out, options) => {
  const scriptPath = path.join(process.cwd(), "heic_to_png.py");
  const pythonPath = "/app/pdfenv/bin/python3";
  
  return new Promise((resolve, reject) => {
    // Validate input file
    if (!inp || !fs.existsSync(inp)) {
      return reject(new Error("Input file does not exist"));
    }
    
    // Generate output filename if not provided
    if (!out) {
      const baseName = path.basename(inp, path.extname(inp));
      out = path.join(path.dirname(inp), `${baseName}.png`);
    }
    
    // Prepare options
    const quality = options?.quality || "medium";
    const resize = options?.resize || "original";
    const preserveExif = options?.preserveExif || true;
    
    // Execute Python script
    const pythonProcess = spawn(pythonPath, [
      scriptPath,
      inp,
      out,
      quality,
      resize,
      preserveExif.toString()
    ]);
    
    let errorData = '';
    
    pythonProcess.stderr.on('data', (data) => {
      errorData += data.toString();
    });
    
    pythonProcess.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`Python script failed: ${errorData}`));
      }
      
      if (!fs.existsSync(out)) {
        return reject(new Error("Output file was not created"));
      }
      
      resolve(out);
    });
  });
},

  "ppt-to-pdf": async (inp, out) => {
    await run("soffice", ["--headless", "--convert-to", "pdf", inp, "--outdir", path.dirname(out)]);
    const gen = path.join(path.dirname(out), path.basename(inp, path.extname(inp)) + ".pdf");
    await fsp.rename(gen, out);
  },

  "doc-to-docx": async (inp, out) => {
    await run("soffice", ["--headless", "--convert-to", "docx", inp, "--outdir", path.dirname(out)]);
    const gen = path.join(path.dirname(out), path.basename(inp, path.extname(inp)) + ".docx");
    await fsp.rename(gen, out);
  },

  // Image Converters
  "jpg-to-pdf": async (inp, out) => { await run("convert", [inp, out]); },
  "png-to-pdf": async (inp, out) => { await run("convert", [inp, out]); },
  "webp-to-png": async (inp, out) => { await run("convert", [inp, out]); },
  "png-to-webp": async (inp, out) => { await run("convert", [inp, out]); },
  "jpg-to-png": async (inp, out) => { await run("convert", [inp, out]); },
  "png-to-jpg": async (inp, out) => { await run("convert", [inp, out]); },
  // SVG to PNG converter using Python
"svg-to-png": async (inp, out) => {
  const { spawn } = require('child_process');
  const path = require('path');
  const fs = require('fs');
  
  return new Promise((resolve, reject) => {
    // Validate input file
    if (!inp || !fs.existsSync(inp)) {
      return reject(new Error("Input file does not exist"));
    }

    // Generate output filename if not provided
    if (!out) {
      const baseName = path.basename(inp, path.extname(inp));
      out = path.join(path.dirname(inp), `${baseName}.png`);
    }

    const scriptPath = path.join(process.cwd(), "svg_to_png.py");
    const pythonPath = "/app/pdfenv/bin/python3";

    console.log(`Converting SVG to PNG: ${inp} -> ${out}`);

    // Execute Python script
    const pythonProcess = spawn(pythonPath, [scriptPath, inp, out]);

    let stdout = "";
    let stderr = "";

    pythonProcess.stdout.on("data", (data) => {
      stdout += data.toString();
      console.log("Python stdout:", data.toString());
    });

    pythonProcess.stderr.on("data", (data) => {
      stderr += data.toString();
      console.error("Python stderr:", data.toString());
    });

    pythonProcess.on("close", (code) => {
      console.log(`Python process exited with code ${code}`);
      
      if (code === 0) {
        // Check if output file was created
        if (fs.existsSync(out)) {
          const stats = fs.statSync(out);
          if (stats.size > 0) {
            console.log("SVG to PNG conversion successful");
            resolve(out);
          } else {
            reject(new Error("Conversion completed but output file is empty"));
          }
        } else {
          reject(new Error("Conversion completed but output file was not created"));
        }
      } else {
        console.error("SVG to PNG conversion failed");
        reject(new Error(`Conversion failed with code ${code}: ${stderr}`));
      }
    });

    pythonProcess.on("error", (err) => {
      console.error("Failed to start Python process:", err);
      reject(new Error("Failed to start conversion process"));
    });
  });
},
 
// SVG to JPG converter using Python
"svg-to-jpg": async (inp, out) => {
  const { spawn } = require('child_process');
  const fs = require('fs');
  const path = require('path');
  
  return new Promise((resolve, reject) => {
    // Validate input file
    if (!inp || !fs.existsSync(inp)) {
      return reject(new Error("Input file does not exist"));
    }

    // Generate output filename if not provided
    if (!out) {
      const baseName = path.basename(inp, path.extname(inp));
      out = path.join(path.dirname(inp), `${baseName}.jpg`);
    }

    const scriptPath = path.join(process.cwd(), "svg_to_jpg.py");
    const pythonPath = "/app/pdfenv/bin/python3";

    console.log(`Converting SVG to JPG: ${inp} -> ${out}`);

    // Execute Python script
    const pythonProcess = spawn(pythonPath, [scriptPath, inp, out]);

    let stdout = "";
    let stderr = "";

    pythonProcess.stdout.on("data", (data) => {
      stdout += data.toString();
      console.log("Python stdout:", data.toString());
    });

    pythonProcess.stderr.on("data", (data) => {
      stderr += data.toString();
      console.error("Python stderr:", data.toString());
    });

    pythonProcess.on("close", (code) => {
      console.log(`Python process exited with code ${code}`);
      
      if (code === 0) {
        // Check if output file was created
        if (fs.existsSync(out)) {
          const stats = fs.statSync(out);
          if (stats.size > 0) {
            console.log("SVG to JPG conversion successful");
            resolve(out);
          } else {
            reject(new Error("Conversion completed but output file is empty"));
          }
        } else {
          reject(new Error("Conversion completed but output file was not created"));
        }
      } else {
        console.error("SVG to JPG conversion failed");
        reject(new Error(`Conversion failed with code ${code}: ${stderr}`));
      }
    });

    pythonProcess.on("error", (err) => {
      console.error("Failed to start Python process:", err);
      reject(new Error("Failed to start conversion process"));
    });
  });
},

  "heic-to-jpg": async (inp, out) => { await run("convert", [inp, out]); },

  // PDF Operations

  "split-pdf-to-images": async (inp, out, req) => {
    const fmt = (req?.body?.format || "jpg").toLowerCase();
  
    // Temp dir for images
    const imgDir = path.join(os.tmpdir(), uuidv4());
    await fsp.mkdir(imgDir, { recursive: true });
  
    const prefix = path.join(imgDir, "page");
    await run("pdftoppm", [
      "-" + (fmt === "png" ? "png" : "jpeg"),
      inp,
      prefix
    ]);
  
    // Collect generated images
    const files = (await fsp.readdir(imgDir))
      .filter(f => f.endsWith(fmt));
  
    // Zip them into output
    const archiver = require("archiver");
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(out);
      const archive = archiver("zip", { zlib: { level: 9 } });
      output.on("close", resolve);
      archive.on("error", reject);
      archive.pipe(output);
      files.forEach(f => archive.file(path.join(imgDir, f), { name: f }));
      archive.finalize();
    });
  },
  


  "pdf-merge": async (inputs, out) => {
    await run("gs", ["-dBATCH", "-dNOPAUSE", "-q", "-sDEVICE=pdfwrite", `-sOutputFile=${out}`, ...inputs]);
  },
  "pdf-split": async (inp, out, req) => {
    const splitOption = req.body.splitOption;
    const pageRanges = req.body.pageRanges;
  
    const outputDir = path.dirname(out);
    const files = [];
  
    if (splitOption === 'custom' && pageRanges) {
      // Split into separate PDFs for each custom range
      const ranges = pageRanges.split(',').map(r => r.trim());
  
      for (let i = 0; i < ranges.length; i++) {
        const range = ranges[i];
        const outFile = path.join(outputDir, `range_${String(i + 1).padStart(3, '0')}.pdf`);
  
        await run("pdftk", [inp, "cat", range, "output", outFile]);
        files.push(outFile);
      }
  
      return files;
    } else {
      // Split all pages (default behavior)
      const outputPattern = path.join(outputDir, "page_%03d.pdf");
      await run("pdftk", [inp, "burst", "output", outputPattern]);
  
      let pageNum = 1;
      let pageFile = path.join(outputDir, `page_${String(pageNum).padStart(3, '0')}.pdf`);
  
      while (fs.existsSync(pageFile)) {
        files.push(pageFile);
        pageNum++;
        pageFile = path.join(outputDir, `page_${String(pageNum).padStart(3, '0')}.pdf`);
      }
  
      return files;
    }
  },
  
  "pdf-to-jpg": async (inp, out) => { 
    await run("convert", ["-density", "150", `${inp}[0]`, out]); 
  },
  "pdf-to-png": async (inp, out) => { 
    await run("convert", ["-density", "150", `${inp}[0]`, out]); 
  },
  
// TXT to PDF converter function using Python

// Debug version of the TXT to PDF converter
"txt-to-pdf": async (inp, out) => {
  const scriptPath = path.join(process.cwd(), "txt_to_pdf.py");
  const pythonPath = "/app/pdfenv/bin/python3";
  
  console.log("=== TXT to PDF Debug Info ===");
  console.log("Input file:", inp);
  console.log("Input exists:", fs.existsSync(inp));
  if (fs.existsSync(inp)) {
    console.log("Input size:", fs.statSync(inp).size, "bytes");
  }
  
  console.log("Python path:", pythonPath);
  console.log("Python exists:", fs.existsSync(pythonPath));
  console.log("Python executable:", fs.accessSync ? "Checking..." : "Cannot check");
  
  console.log("Script path:", scriptPath);
  console.log("Script exists:", fs.existsSync(scriptPath));
  
  // Check if Python is executable
  try {
    fs.accessSync(pythonPath, fs.constants.X_OK);
    console.log("Python is executable");
  } catch (e) {
    console.log("Python is NOT executable:", e.message);
  }
  
  return new Promise((resolve, reject) => {
    // Generate output filename if not provided
    if (!out) {
      const baseName = path.basename(inp, path.extname(inp));
      out = path.join(path.dirname(inp), `${baseName}.pdf`);
    }
    
    console.log("Output path:", out);

    // Execute Python script
    const pythonProcess = spawn(pythonPath, [scriptPath, inp, out]);
    
    let stdout = "";
    let stderr = "";

    pythonProcess.stdout.on("data", (data) => {
      stdout += data.toString();
      console.log("Python stdout:", data.toString());
    });

    pythonProcess.stderr.on("data", (data) => {
      stderr += data.toString();
      console.error("Python stderr:", data.toString());
    });

    pythonProcess.on("close", (code) => {
      console.log(`Python process exited with code ${code}`);
      
      if (code === 0) {
        // Check if output file was created
        if (fs.existsSync(out)) {
          const stats = fs.statSync(out);
          console.log("Output file created, size:", stats.size, "bytes");
          if (stats.size > 0) {
            console.log("TXT to PDF conversion successful");
            resolve(out);
          } else {
            reject(new Error("Conversion completed but output file is empty"));
          }
        } else {
          console.log("Output file does not exist at path:", out);
          reject(new Error("Conversion completed but output file was not created"));
        }
      } else {
        console.error("TXT to PDF conversion failed");
        reject(new Error(`Conversion failed with code ${code}: ${stderr}`));
      }
    });

    pythonProcess.on("error", (err) => {
      console.error("Failed to start Python process:", err);
      reject(new Error("Failed to start conversion process. Check Python installation."));
    });
  });
},

  "doc-to-docx": async (inp, out) => {
    await run("soffice", [
        "--headless",
        "--convert-to", "docx",
        inp,
        "--outdir", path.dirname(out)
    ]);
    const gen = path.join(path.dirname(out), path.basename(inp, path.extname(inp)) + ".docx");
    await fsp.rename(gen, out);
  },
  "excel-to-pdf": async (inp, out) => {
  await run("soffice", [
    "--headless",
    "--convert-to", "pdf",
    inp,
    "--outdir", path.dirname(out)
  ]);
  const gen = path.join(
    path.dirname(out),
    path.basename(inp, path.extname(inp)) + ".pdf"
  );
  await fsp.rename(gen, out);
},

"csv-to-pdf": async (inp, out) => {
  await run("soffice", [
    "--headless",
    "--convert-to", "pdf",
    inp,
    "--outdir", path.dirname(out)
  ]);
  const gen = path.join(
    path.dirname(out),
    path.basename(inp, path.extname(inp)) + ".pdf"
  );
  await fsp.rename(gen, out);
},

  
  "rar-to-zip": async (inp, out) => {
    try {
      console.log(`Converting RAR to ZIP: ${inp} -> ${out}`);
      
      // Check if input file exists
      if (!fs.existsSync(inp)) {
        throw new Error("Input RAR file not found");
      }
      
      // Ensure output has .zip extension
      if (!out.toLowerCase().endsWith('.zip')) {
        out = out + '.zip';
      }
      
      // Create a temporary directory to extract files
      const tempDir = path.join(os.tmpdir(), `rar_to_zip_${uuidv4()}`);
      await fsp.mkdir(tempDir, { recursive: true });
      
      console.log(`Extracting RAR to temporary directory: ${tempDir}`);
      
      // Extract RAR file using unrar (system command)
      try {
        await run("unrar", ["x", "-y", inp, tempDir + "/"]);
      } catch (unrarError) {
        console.log("unrar command failed, trying with unar...");
        
        // Fallback to unar if unrar is not available
        try {
          await run("unar", ["-o", tempDir, inp]);
        } catch (unarError) {
          console.log("unar also failed, trying Node.js fallback...");
          throw new Error("Both unrar and unar commands failed");
        }
      }
      
      // Create ZIP archive using AdmZip
      const zip = new AdmZip();
      
      // Recursively add all files to ZIP
      const addFilesToZip = (dirPath, zipPath = '') => {
        const files = fs.readdirSync(dirPath);
        
        files.forEach(file => {
          const fullPath = path.join(dirPath, file);
          const relativePath = path.join(zipPath, file);
          const stat = fs.statSync(fullPath);
          
          if (stat.isDirectory()) {
            // Add directory entry
            zip.addFile(relativePath + '/', Buffer.alloc(0));
            addFilesToZip(fullPath, relativePath);
          } else {
            // Add file
            const fileData = fs.readFileSync(fullPath);
            zip.addFile(relativePath, fileData);
          }
        });
      };
      
      addFilesToZip(tempDir);
      
      // Write ZIP file
      zip.writeZip(out);
      
      // Clean up temporary directory
      await fsp.rm(tempDir, { recursive: true, force: true });
      
      // Verify the output was created
      const stats = await fsp.stat(out);
      if (!stats || stats.size === 0) {
        throw new Error("ZIP conversion failed - output file is empty");
      }
      
      console.log(`ZIP created successfully: ${stats.size} bytes`);
      return out;
      
    } catch (error) {
      console.error("RAR to ZIP conversion failed:", error);
      
      // Fallback: Try Python-based conversion
      try {
        console.log("Trying Python fallback for RAR to ZIP...");
        const pythonPath = "python3";
        
        const pythonScript = `
  import sys
  import os
  import zipfile
  import tempfile
  import shutil
  import subprocess
  
  def convert_rar_to_zip(input_path, output_path):
      try:
          # Check if input exists
          if not os.path.exists(input_path):
              return False, "Input file does not exist"
          
          # Create temporary directory
          temp_dir = tempfile.mkdtemp()
          
          try:
              # Try to extract RAR using unrar first
              try:
                  result = subprocess.run([
                      "unrar", "x", "-y", input_path, temp_dir + "/"
                  ], capture_output=True, text=True, timeout=300)
                  
                  if result.returncode != 0:
                      # Try unar as fallback
                      result = subprocess.run([
                          "unar", "-o", temp_dir, input_path
                      ], capture_output=True, text=True, timeout=300)
                      
                      if result.returncode != 0:
                          return False, f"RAR extraction failed: {result.stderr}"
              
              except FileNotFoundError:
                  return False, "RAR extraction tools (unrar/unar) not installed"
              
              # Create ZIP file
              with zipfile.ZipFile(output_path, 'w', zipfile.ZIP_DEFLATED) as zip_ref:
                  for root, dirs, files in os.walk(temp_dir):
                      for file in files:
                          file_path = os.path.join(root, file)
                          # Preserve directory structure
                          arcname = os.path.relpath(file_path, temp_dir)
                          zip_ref.write(file_path, arcname)
              
              # Verify output
              if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
                  return True, "Conversion successful"
              else:
                  return False, "Output file was not created"
                  
          finally:
              # Clean up temporary directory
              shutil.rmtree(temp_dir, ignore_errors=True)
              
      except Exception as e:
          return False, f"Error: {str(e)}"
  
  if __name__ == "__main__":
      if len(sys.argv) != 3:
          print("ERROR: Usage: python_script.py <input> <output>")
          sys.exit(1)
      
      success, message = convert_rar_to_zip(sys.argv[1], sys.argv[2])
      if success:
          print("SUCCESS:" + message)
      else:
          print("ERROR:" + message)
          sys.exit(1)
  `;
        
        const scriptPath = path.join(os.tmpdir(), `rar_to_zip_${uuidv4()}.py`);
        await fsp.writeFile(scriptPath, pythonScript);
        
        // Check if python is available
        try {
          await run(pythonPath, ['--version']);
        } catch (e) {
          throw new Error("Python is not available on this system");
        }
        
        const { stdout, stderr } = await run(pythonPath, [
          scriptPath,
          inp,
          out
        ]);
        
        // Clean up temporary script
        await fsp.unlink(scriptPath).catch(() => {});
        
        if (stdout.includes("SUCCESS:")) {
          console.log("RAR to ZIP succeeded via Python fallback");
          return out;
        } else {
          throw new Error(stdout.includes("ERROR:") ? stdout.split("ERROR:")[1].trim() : "Python conversion failed");
        }
        
      } catch (fallbackError) {
        console.error("Python fallback also failed:", fallbackError);
        throw new Error(`Failed to convert RAR to ZIP: ${error.message}. Python fallback also failed: ${fallbackError.message}`);
      }
    }
  },



  "csv-to-json": async (inp, out) => {
    await run("python3", [
        "-c",
        `import csv, json;
with open('${inp}') as f:
    reader = csv.DictReader(f);
    data = [row for row in reader];
with open('${out}', 'w') as f:
    json.dump(data, f)`
    ]);
  },
  "remove-pages-pdf": async (inp, out, req) => {
    const pagesToRemove = req.body.pagesToRemove;
    if (!pagesToRemove) throw new Error("No pages specified to remove");
  
    // Find total number of pages
    const tempInfo = path.join(os.tmpdir(), `${uuidv4()}.txt`);
    await run("pdftk", [inp, "dump_data", "output", tempInfo]);
    const info = await fsp.readFile(tempInfo, "utf8");
    await fsp.unlink(tempInfo);
  
    const match = info.match(/NumberOfPages:\s+(\d+)/);
    if (!match) throw new Error("Failed to detect number of pages");
    const totalPages = parseInt(match[1], 10);
  
    // Parse remove pages
    const removeSet = new Set();
    pagesToRemove.split(',').map(r => r.trim()).forEach(r => {
      if (r.includes('-')) {
        const [start, end] = r.split('-').map(n => parseInt(n.trim(), 10));
        for (let i = start; i <= end; i++) removeSet.add(i);
      } else {
        removeSet.add(parseInt(r, 10));
      }
    });
  
    // Build keep list
    const keepPages = [];
    for (let i = 1; i <= totalPages; i++) {
      if (!removeSet.has(i)) keepPages.push(i);
    }
    if (keepPages.length === 0) throw new Error("No pages left after removal!");
  
    // ✅ Compress keepPages into ranges
    const ranges = [];
    let start = keepPages[0];
    let prev = keepPages[0];
  
    for (let i = 1; i < keepPages.length; i++) {
      const curr = keepPages[i];
      if (curr === prev + 1) {
        prev = curr;
        continue;
      }
      ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
      start = curr;
      prev = curr;
    }
    ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
  
    // Run pdftk with proper ranges
    await run("pdftk", [inp, "cat", ...ranges, "output", out]);
  },
  
  
  // OCR Operations

    "ocr-pdf-to-word": async (inp, out, req) => {
        const pythonPath = "/app/pdfenv/bin/python3";
        const tempDir = path.join(os.tmpdir(), uuidv4());
        
        try {
            await fsp.mkdir(tempDir);
            console.log(`Starting high-accuracy PDF to Word conversion for: ${inp}`);

            // First try direct conversion for digital PDFs
            try {
                const directScript = `
from pdf2docx import Converter
import docx

cv = Converter("${inp}")
cv.convert("${out}")
cv.close()

doc = docx.Document("${out}")
word_count = sum(len(p.text.split()) for p in doc.paragraphs)
if word_count > 10:
    print("Direct conversion successful")
    exit(0)
else:
    print("Direct conversion empty")
    exit(1)
`;
                const scriptPath = path.join(tempDir, "direct.py");
                await fsp.writeFile(scriptPath, directScript);
                await run(pythonPath, [scriptPath]);
                
                console.log("Direct conversion successful");
                return;
                
            } catch (directError) {
                console.log("Direct conversion failed, trying high-accuracy OCR...");
            }

            // Use high-accuracy OCR for scanned PDFs
            await processScannedPdfHighAccuracy(inp, out, tempDir, pythonPath);
            
            console.log("High-accuracy OCR conversion completed successfully");
            
        } catch (error) {
            console.error("High-accuracy conversion failed:", error);
            
            // Fallback to basic text extraction
            try {
                const textOutput = path.join(tempDir, "raw_text.txt");
                await run("pdftotext", ["-layout", "-enc", "UTF-8", inp, textOutput]);
                
                const fallbackScript = `
from docx import Document

try:
    with open("${textOutput}", "r", encoding="utf-8", errors="ignore") as f:
        content = f.read()
except:
    content = ""

doc = Document()
if content.strip():
    paragraphs = [p.strip() for p in content.split('\\n\\n') if p.strip()]
    for para in paragraphs[:50]:
        doc.add_paragraph(para)
else:
    doc.add_paragraph("OCR failed. Please try a higher quality scan.")
    
doc.save("${out}")
`;
                const scriptPath = path.join(tempDir, "fallback.py");
                await fsp.writeFile(scriptPath, fallbackScript);
                await run(pythonPath, [scriptPath]);
                
            } catch (fallbackError) {
                throw new Error(`All conversion methods failed: ${error.message}`);
            }
        } finally {
            await fsp.rm(tempDir, { recursive: true }).catch(() => {});
        }
    },

  "image-to-text-ocr": async (inp, out, req) => {
    console.log(`Starting OCR for: ${inp}`);
    
    // Read the first few bytes to check file type
    const fd = fs.openSync(inp, 'r');
    const buffer = Buffer.alloc(4);
    fs.readSync(fd, buffer, 0, 4, 0);
    fs.closeSync(fd);
    
    const header = buffer.toString('hex');
    console.log(`File header: ${header}`);
    
    // Check if it's a PDF (starts with "%PDF")
    if (header.startsWith('25504446')) { // %PDF in hex
      console.log("File is PDF - using pdftotext");
      await run("pdftotext", [
        "-layout",
        "-enc", "UTF-8",
        inp,
        out
      ]);
    } else {
      console.log("File is image - using tesseract");
      // Use a completely separate approach for images
      
      // Create a safe temporary filename for tesseract
      const tempDir = path.join(os.tmpdir(), uuidv4());
      await fsp.mkdir(tempDir);
      const tempOutput = path.join(tempDir, "output");
      
      try {
        await run("tesseract", [
          inp,
          tempOutput,
          "-l", "eng"
        ]);
        
        // Check which file tesseract created
        const possibleOutputs = [
          tempOutput + '.txt',
          tempOutput,
          path.join(path.dirname(inp), path.basename(tempOutput) + '.txt')
        ];
        
        let foundOutput = null;
        for (const possible of possibleOutputs) {
          if (fs.existsSync(possible)) {
            foundOutput = possible;
            break;
          }
        }
        
        if (foundOutput) {
          await fsp.rename(foundOutput, out);
        } else {
          throw new Error("Tesseract output file not found");
        }
        
      } finally {
        await fsp.rm(tempDir, { recursive: true }).catch(() => {});
      }
    }
  },
  

// PDF Operations
"pdf-compress": async (inp, out) => {
  await run("gs", [
    "-sDEVICE=pdfwrite",
    "-dCompatibilityLevel=1.4",
    "-dPDFSETTINGS=/ebook",
    "-dNOPAUSE",
    "-dQUIET",
    "-dBATCH",
    `-sOutputFile=${out}`,
    inp
  ]);
},

"pdf-repair": async (inp, out) => {
  await run("gs", [
    "-o", out,
    "-sDEVICE=pdfwrite",
    "-dPDFSETTINGS=/prepress",
    inp
  ]);
},

"add-pdf-password": async (inp, out, req) => {
  const password = req.body.password ? req.body.password.trim() : null;
  if (!password) throw new Error("Password is required");

  // Run qpdf to encrypt with AES-256 (owner & user passwords same)
  await run("qpdf", [
    "--encrypt", password, password, "256", "--",
    inp, out
  ]);
},
"compress-archive": async (inp, out) => {
  const { spawn } = require("child_process");

  return new Promise((resolve, reject) => {
    const py = spawn("python3", ["-u", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const script = `
import sys, os, zipfile, tarfile, tempfile, shutil

def compress_archive(input_file, output_file):
    input_ext = os.path.splitext(input_file)[1].lower()
    output_ext = os.path.splitext(output_file)[1].lower()

    if not os.path.exists(input_file):
        raise FileNotFoundError(f"Input file not found: {input_file}")

    temp_dir = tempfile.mkdtemp()
    try:
        # --- Extract ---
        if input_ext == ".zip":
            with zipfile.ZipFile(input_file, "r") as z:
                z.extractall(temp_dir)
        elif input_ext in [".tar", ".gz", ".tgz", ".bz2", ".xz"]:
            with tarfile.open(input_file, "r:*") as t:
                t.extractall(temp_dir)
        else:
            raise ValueError(f"Unsupported input archive type: {input_ext}")

        # --- Recompress ---
        if output_ext == ".zip":
            with zipfile.ZipFile(output_file, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
                for root, _, files in os.walk(temp_dir):
                    for f in files:
                        full_path = os.path.join(root, f)
                        rel_path = os.path.relpath(full_path, temp_dir)
                        z.write(full_path, rel_path)
        elif output_ext in [".tar", ".tar.gz", ".tgz", ".tar.bz2", ".tar.xz"]:
            if output_ext in [".tar.gz", ".tgz"]:
                mode = "w:gz"
            elif output_ext == ".tar.bz2":
                mode = "w:bz2"
            elif output_ext == ".tar.xz":
                mode = "w:xz"
            else:
                mode = "w"
            with tarfile.open(output_file, mode) as t:
                t.add(temp_dir, arcname=".")
        else:
            raise ValueError(f"Unsupported output archive type: {output_ext}")

        print("SUCCESS")
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

if __name__ == "__main__":
    try:
        compress_archive(sys.argv[1], sys.argv[2])
    except Exception as e:
        print(f"ERROR: {e}")
        sys.exit(1)
    `;

    py.stdin.write(script);
    py.stdin.end();

    py.stdout.on("data", (data) => {
      if (data.toString().includes("SUCCESS")) resolve();
      if (data.toString().includes("ERROR")) reject(new Error(data.toString()));
    });

    py.stderr.on("data", (data) => reject(new Error(data.toString())));
  });
},


"remove-pdf-password": async (inp, out, req) => {
  const password = req.body.password ? req.body.password.trim() : "";

  // Run qpdf to decrypt (remove protection)
  await run("qpdf", [
    `--password=${password}`,
    "--decrypt",
    inp,
    out
  ]);
},
// Add to your converters object
"pdf-to-ocr-searchable": async (inp, out, req) => {
  let tempInput = inp; // We'll use this to track if we need to copy the file
  
  try {
    console.log(`Converting PDF to searchable: ${inp}`);
    
    // Check if the input file exists
    if (!fs.existsSync(inp)) {
      throw new Error(`Input file not found: ${inp}`);
    }
    
    // Make a copy of the file to ensure it doesn't get deleted during processing
    const tempDir = path.join(os.tmpdir(), uuidv4());
    await fsp.mkdir(tempDir, { recursive: true });
    tempInput = path.join(tempDir, "input.pdf");
    
    // Copy the file to ensure it stays available
    await fsp.copyFile(inp, tempInput);
    console.log(`Copied input file to: ${tempInput}`);
    
    // Use ocrmypdf to create searchable PDF
    const args = [
      "--force-ocr",
      "--language", "eng",
      "--output-type", "pdf",
      "--jobs", "4",
      "--clean",
      "--tesseract-timeout", "300",
      tempInput, // Use the copied file
      out
    ];

    console.log(`Running ocrmypdf with args: ${args.join(' ')}`);
    
    await run("ocrmypdf", args);

    // Verify the output was created
    if (!fs.existsSync(out)) {
      throw new Error("Searchable PDF was not created");
    }

    const stats = await fsp.stat(out);
    console.log(`Searchable PDF created: ${stats.size} bytes`);

  } catch (error) {
    console.error("PDF to searchable conversion failed:", error);
    
    // Provide user-friendly error messages
    if (error.message.includes("command not found")) {
      throw new Error("OCR software not installed. Please install ocrmypdf: pip install ocrmypdf");
    } else if (error.message.includes("File not found")) {
      throw new Error("Input file was unavailable during processing. Please try again.");
    } else {
      throw new Error(`Failed to create searchable PDF: ${error.message}`);
    }
  } finally {
    // Clean up the temporary copy if we created one
    if (tempInput !== inp) {
      try {
        await fsp.unlink(tempInput).catch(() => {});
        await fsp.rm(path.dirname(tempInput), { recursive: true }).catch(() => {});
      } catch (cleanupError) {
        console.error("Error cleaning up temp files:", cleanupError);
      }
    }
  }
},

"pdf-to-svg": async (inp, out) => {
  await run("pdf2svg", [inp, out, "1"]); // Convert first page to SVG
},

// Presentation Converters
"ppt-to-images": async (inp, out) => {
  await run("soffice", [
    "--headless",
    "--convert-to", "png",
    inp,
    "--outdir", path.dirname(out)
  ]);
  const gen = path.join(path.dirname(out), path.basename(inp, path.extname(inp)) + ".png");
  await fsp.rename(gen, out);
},


"pptx-to-images": async (inp, out) => {
  await run("soffice", [
    "--headless",
    "--convert-to", "png",
    inp,
    "--outdir", path.dirname(out)
  ]);
  const gen = path.join(path.dirname(out), path.basename(inp, path.extname(inp)) + ".png");
  await fsp.rename(gen, out);
},
// PDF to PPT converter function using Python script with custom Python path
"pdf-to-ppt": async (inp, out) => {
  const scriptPath = path.join(process.cwd(), "pdf_to_pptx.py");
  const pythonPath = "/app/pdfenv/bin/python3";
  
  return new Promise((resolve, reject) => {
    // Validate input file
    if (!inp || !fs.existsSync(inp)) {
      return reject(new Error("Input file does not exist"));
    }

    // Generate output filename if not provided
    if (!out) {
      const baseName = path.basename(inp, path.extname(inp));
      out = path.join(path.dirname(inp), `${baseName}.pptx`);
    }

    // Execute Python script with custom Python path
    const pythonProcess = spawn(pythonPath, [scriptPath, inp, out]);
    
    let stdout = "";
    let stderr = "";

    pythonProcess.stdout.on("data", (data) => {
      stdout += data.toString();
    });

    pythonProcess.stderr.on("data", (data) => {
      stderr += data.toString();
    });

    pythonProcess.on("close", (code) => {
      if (code === 0) {
        console.log("PDF to PPT conversion successful");
        console.log("Output:", stdout);
        resolve(out);
      } else {
        console.error("PDF to PPT conversion failed");
        console.error("Error:", stderr);
        reject(new Error(`Conversion failed with code ${code}: ${stderr}`));
      }
    });

    pythonProcess.on("error", (err) => {
      console.error("Failed to start Python process:", err);
      reject(new Error("Failed to start conversion process"));
    });
  });
},

// Document Converters
"docx-to-png": async (inp, out, req) => {
  const tempPdf = path.join(os.tmpdir(), `${uuidv4()}.pdf`);

  // Step 1: DOCX → PDF with LibreOffice
  await run("soffice", [
    "--headless",
    "--convert-to", "pdf",
    inp,
    "--outdir", path.dirname(tempPdf)
  ]);

  const genPdf = path.join(path.dirname(tempPdf), path.basename(inp, path.extname(inp)) + ".pdf");
  await fsp.rename(genPdf, tempPdf);

  // Step 2: PDF → PNG (all pages)
  const outPattern = path.join(path.dirname(out), path.basename(inp, path.extname(inp)) + "_page_%03d.png");
  await run("convert", [
    "-density", "150",
    tempPdf,
    "-quality", "90",
    outPattern
  ]);

  await fsp.unlink(tempPdf).catch(() => {});

  // Collect generated PNGs
  const files = [];
  let pageNum = 0;
  while (true) {
    const candidate = path.join(path.dirname(out), `${path.basename(inp, path.extname(inp))}_page_${String(pageNum).padStart(3, "0")}.png`);
    if (!fs.existsSync(candidate)) break;
    files.push(candidate);
    pageNum++;
  }

  if (files.length === 0) {
    throw new Error("No PNGs generated");
  }

  return files;
},



"docx-to-txt": async (inp, out) => {
  await run("soffice", [
    "--headless",
    "--convert-to", "txt:Text",
    inp,
    "--outdir", path.dirname(out)
  ]);
  const gen = path.join(path.dirname(out), path.basename(inp, path.extname(inp)) + ".txt");
  await fsp.rename(gen, out);
},

// Add to your converters object
"md-to-html": async (inp, out) => {
  try {
    console.log(`Converting Markdown to HTML: ${inp} -> ${out}`);
    
    // Read the markdown file content
    const markdownContent = await fsp.readFile(inp, 'utf8');
    
    // Use Python with markdown library for conversion
    const pythonPath = "/app/pdfenv/bin/python3";
    
    const pythonScript = `
import markdown
import sys

def convert_markdown_to_html(input_file, output_file):
    try:
        # Read markdown content
        with open(input_file, 'r', encoding='utf-8') as f:
            md_content = f.read()
        
        # Convert markdown to HTML
        html_content = markdown.markdown(md_content, extensions=['extra', 'tables'])
        
        # Add basic HTML structure
        full_html = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Converted Markdown</title>
    <style>
        body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; max-width: 800px; margin: 0 auto; padding: 20px; }}
        h1, h2, h3, h4, h5, h6 {{ color: #2c3e50; margin-top: 1.5em; }}
        code {{ background: #f4f4f4; padding: 2px 6px; border-radius: 3px; }}
        pre {{ background: #f8f9fa; padding: 15px; border-radius: 5px; overflow: auto; }}
        pre code {{ background: none; padding: 0; }}
        table {{ border-collapse: collapse; width: 100%; margin: 1em 0; }}
        th, td {{ border: 1px solid #ddd; padding: 8px; text-align: left; }}
        th {{ background-color: #f2f2f2; }}
        blockquote {{ border-left: 4px solid #ddd; padding-left: 15px; margin-left: 0; color: #666; }}
        img {{ max-width: 100%; height: auto; }}
    </style>
</head>
<body>
{html_content}
</body>
</html>"""
        
        # Write HTML output
        with open(output_file, 'w', encoding='utf-8') as f:
            f.write(full_html)
        
        return True
        
    except Exception as e:
        print(f"Error: {e}")
        return False

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("ERROR: Usage: python_script.py <input> <output>")
        exit(1)
    
    success = convert_markdown_to_html(sys.argv[1], sys.argv[2])
    exit(0 if success else 1)
`;

    // Write Python script to temporary file
    const scriptPath = path.join(os.tmpdir(), `md_to_html_${uuidv4()}.py`);
    await fsp.writeFile(scriptPath, pythonScript);
    
    // Execute Python script
    await run(pythonPath, [scriptPath, inp, out]);
    
    // Clean up script file
    await fsp.unlink(scriptPath).catch(() => {});
    
    // Verify the output was created
    const stats = await fsp.stat(out);
    if (!stats || stats.size === 0) {
      throw new Error("HTML conversion failed - output file is empty");
    }
    
    console.log(`HTML created successfully: ${stats.size} bytes`);
    return out;
    
  } catch (error) {
    console.error("Markdown to HTML conversion failed:", error);
    
    // Fallback: Use Node.js markdown library if Python fails
    try {
      console.log("Trying Node.js fallback...");
      const markdownContent = await fsp.readFile(inp, 'utf8');
      
      // You can use a Node.js markdown library here if installed
      // For now, let's use a simple regex-based converter as fallback
      const simpleHtml = convertMarkdownSimple(markdownContent);
      
      await fsp.writeFile(out, simpleHtml);
      
      const stats = await fsp.stat(out);
      if (stats && stats.size > 0) {
        console.log("HTML created successfully with Node.js fallback");
        return out;
      }
    } catch (fallbackError) {
      console.error("Node.js fallback also failed:", fallbackError);
    }
    
    throw new Error(`Failed to convert Markdown to HTML: ${error.message}`);
  }
},


"html-to-md": async (inp, out) => {
  await run("pandoc", [
    "-f", "html",
    "-t", "markdown_strict",
    inp,
    "-o", out
  ]);
},

// Add to your converters object
"remove-metadata-image": async (inp, out) => {
  try {
    console.log(`Removing metadata from image: ${inp} -> ${out}`);
    
    // Use sharp to process the image and strip metadata
    await sharp(inp)
      .withMetadata({}) // Empty metadata object removes all metadata
      .toFile(out);
    
    // Verify the output was created
    const stats = await fsp.stat(out);
    if (!stats || stats.size === 0) {
      throw new Error("Metadata removal failed - output file is empty");
    }
    
    console.log(`Metadata removed successfully: ${stats.size} bytes`);
    return out;
    
  } catch (error) {
    console.error("Metadata removal failed:", error);
    
    // Fallback: Try using ImageMagick if sharp fails
    try {
      console.log("Trying ImageMagick fallback for metadata removal...");
      await run("convert", [
        inp,
        "-strip", // This removes all metadata and profiles
        out
      ]);
      
      const stats = await fsp.stat(out);
      if (stats && stats.size > 0) {
        console.log("Metadata removed successfully with ImageMagick fallback");
        return out;
      }
    } catch (fallbackError) {
      console.error("ImageMagick fallback also failed:", fallbackError);
    }
    
    throw new Error(`Failed to remove metadata: ${error.message}`);
  }
},

// Image Converters
"jpg-to-heic": async (inp, out) => {
  await run("convert", [
    inp,
    out
  ]);
},
"resize-image": async (inp, out, req) => {
  console.log("=== DIRECT RESIZE ===");
  
  // Direct parameter extraction - no complex calculations
  const resizeMode = req?.body?.resizeMode || "dimensions";
  const width = req?.body?.width;
  const height = req?.body?.height;
  const percentage = req?.body?.percentage;
  const longestSide = req?.body?.longestSide;
  const maintainAspect = req?.body?.maintainAspect;
  
  console.log("Raw parameters:", { resizeMode, width, height, percentage, longestSide, maintainAspect });
  
  // Build ImageMagick command based directly on provided parameters
  const args = [inp];
  
  if (resizeMode === "dimensions" && width) {
    if (height && maintainAspect !== "true") {
      args.push("-resize", `${width}x${height}!`); // Exact dimensions
    } else {
      args.push("-resize", `${width}x`); // Maintain aspect ratio
    }
  } 
  else if (resizeMode === "percentage" && percentage) {
    args.push("-resize", `${percentage}%`);
  }
  else if (resizeMode === "longestSide" && longestSide) {
    args.push("-resize", `${longestSide}x${longestSide}>`); // Only resize if larger
  }
  else {
    // No valid resize parameters, just optimize the image
    console.log("No valid resize parameters, optimizing only");
  }
  
  // Always add optimization to reduce file size
  args.push("-strip", "-quality", "85", out);
  
  console.log(`Running: convert ${args.join(' ')}`);
  await run("convert", args);
  
  // Verify the output was created
  const stats = await fsp.stat(out);
  if (!stats || stats.size === 0) {
    throw new Error("Resize failed - output file is empty");
  }
  
  console.log(`Resize completed. File size: ${stats.size} bytes`);
},

"compress-image": async (inp, out, req) => {
  // Extract parameters from different possible sources
  let compressionPercentage = 70; // Default medium compression
  let outputFormat = "same";
  let maxWidth = null;
  let maxHeight = null;
  
  // Try to get parameters from req.body (for single file conversions)
  if (req && req.body) {
    compressionPercentage = parseInt(req.body.compressionPercentage) || compressionPercentage;
    outputFormat = req.body.outputFormat || outputFormat;
    maxWidth = req.body.maxWidth ? parseInt(req.body.maxWidth) : maxWidth;
    maxHeight = req.body.maxHeight ? parseInt(req.body.maxHeight) : maxHeight;
  }
  
  // For multi-file conversions, parameters might be in the request query
  if (req && req.query && Object.keys(req.query).length > 0) {
    compressionPercentage = parseInt(req.query.compressionPercentage) || compressionPercentage;
    outputFormat = req.query.outputFormat || outputFormat;
    maxWidth = req.query.maxWidth ? parseInt(req.query.maxWidth) : maxWidth;
    maxHeight = req.query.maxHeight ? parseInt(req.query.maxHeight) : maxHeight;
  }
  
  // Ensure compression percentage is within valid range (1-100)
  compressionPercentage = Math.max(1, Math.min(100, compressionPercentage));
  
  console.log(`Compressing image: ${inp}`);
  console.log(`Compression: ${compressionPercentage}%, Format: ${outputFormat}, Max dimensions: ${maxWidth}x${maxHeight}`);
  
  // Determine output format
  let actualOutputFormat = outputFormat;
  if (outputFormat === "same") {
    const ext = path.extname(inp).toLowerCase().substring(1);
    actualOutputFormat = ext === "jpeg" ? "jpg" : ext;
  }
  
  // For PNG files, we need a different approach to ensure compression works
  const inputExt = path.extname(inp).toLowerCase().substring(1);
  const isPngInput = inputExt === 'png';
  const isPngOutput = actualOutputFormat === 'png';
  
  // Build ImageMagick command - use different approaches for different formats
  let args = [inp];
  
  // Add resize if specified
  if (maxWidth || maxHeight) {
    let resizeParam = "";
    if (maxWidth && maxHeight) {
      resizeParam = `${maxWidth}x${maxHeight}>`; // Only resize if larger
    } else if (maxWidth) {
      resizeParam = `${maxWidth}>`;
    } else if (maxHeight) {
      resizeParam = `x${maxHeight}>`;
    }
    args.push("-resize", resizeParam);
  }
  
  // For PNG output, we need to handle compression differently
  if (isPngOutput) {
    // PNG compression - use a different approach
    // Higher percentage = less compression for PNG
    const pngCompressionLevel = Math.floor((100 - compressionPercentage) / 10); // 0-9 scale
    args.push("-quality", "95"); // Keep quality high for PNG
    args.push("-define", `png:compression-level=${pngCompressionLevel}`);
  } else {
    // For JPG/WEBP - use quality parameter directly
    // Invert the percentage: higher percentage = higher quality = larger file
    const quality = compressionPercentage;
    args.push("-quality", quality.toString());
    
    // For JPG, add progressive encoding for better compression
    if (actualOutputFormat === 'jpg' || actualOutputFormat === 'jpeg') {
      args.push("-interlace", "Plane");
    }
  }
  
  // For format conversion, we need to handle it differently
  if (actualOutputFormat !== inputExt) {
    // If format conversion is needed, change the output filename extension
    const newOut = out.replace(/\.[^.]+$/, `.${actualOutputFormat}`);
    args.push(newOut);
    
    console.log(`Running convert with args: ${args.join(' ')}`);
    await run("convert", args);
    
    // Update the output path for the rest of the system
    try {
      await fsp.rename(newOut, out);
    } catch (error) {
      console.log(`Could not rename file, keeping original output: ${error.message}`);
    }
  } else {
    // No format conversion needed
    args.push(out);
    console.log(`Running convert with args: ${args.join(' ')}`);
    await run("convert", args);
  }
  
  // Verify the output was created
  const stats = await fsp.stat(out);
  if (!stats || stats.size === 0) {
    throw new Error("Compression failed - output file is empty");
  }
  
  // Get original file size for comparison
  const originalStats = await fsp.stat(inp);
  const sizeReduction = ((originalStats.size - stats.size) / originalStats.size * 100).toFixed(1);
  
  console.log(`Compression successful: ${stats.size} bytes (${sizeReduction}% reduction)`);
  
  // If the file size increased, try a more aggressive approach
  if (stats.size > originalStats.size && compressionPercentage > 30) {
    console.log(`File size increased, trying more aggressive compression...`);
    
    // Try again with more aggressive settings
    const aggressiveQuality = Math.max(10, compressionPercentage - 30);
    let aggressiveArgs = [inp];
    
    if (maxWidth || maxHeight) {
      let resizeParam = "";
      if (maxWidth && maxHeight) {
        resizeParam = `${maxWidth}x${maxHeight}>`;
      } else if (maxWidth) {
        resizeParam = `${maxWidth}>`;
      } else if (maxHeight) {
        resizeParam = `x${maxHeight}>`;
      }
      aggressiveArgs.push("-resize", resizeParam);
    }
    
    if (isPngOutput) {
      const pngCompressionLevel = Math.floor((100 - aggressiveQuality) / 10);
      aggressiveArgs.push("-quality", "90");
      aggressiveArgs.push("-define", `png:compression-level=${pngCompressionLevel}`);
    } else {
      aggressiveArgs.push("-quality", aggressiveQuality.toString());
      if (actualOutputFormat === 'jpg' || actualOutputFormat === 'jpeg') {
        aggressiveArgs.push("-interlace", "Plane");
      }
    }
    
    aggressiveArgs.push(out);
    
    console.log(`Trying aggressive compression with args: ${aggressiveArgs.join(' ')}`);
    await run("convert", aggressiveArgs);
    
    const newStats = await fsp.stat(out);
    const newSizeReduction = ((originalStats.size - newStats.size) / originalStats.size * 100).toFixed(1);
    console.log(`Aggressive compression result: ${newStats.size} bytes (${newSizeReduction}% reduction)`);
  }
  
  return out;
},

// Add to your converters object
"add-watermark-image": async (inp, out, req) => {
  try {
    console.log("Request body:", req.body);
    console.log("Request files:", req.files);
    
    // Get parameters from form data with defaults
    const watermarkText = req.body?.watermarkText || "SAMPLE";
    const opacity = req.body?.opacity || "0.5";
    const position = req.body?.position || "center";
    const fontSize = req.body?.fontSize || "36";
    
    console.log(`Adding watermark to image: ${inp}`);
    console.log(`Watermark text: ${watermarkText}, Opacity: ${opacity}, Position: ${position}, Font size: ${fontSize}`);

    // Build ImageMagick command based on position
    let gravity, coordinates, rotate;
    
    switch(position) {
      case "top-left":
        gravity = "northwest";
        coordinates = "20,20";
        rotate = "0";
        break;
      case "top-right":
        gravity = "northeast";
        coordinates = "20,20";
        rotate = "0";
        break;
      case "bottom-left":
        gravity = "southwest";
        coordinates = "20,20";
        rotate = "0";
        break;
      case "bottom-right":
        gravity = "southeast";
        coordinates = "20,20";
        rotate = "0";
        break;
      case "center":
        gravity = "center";
        coordinates = "0,0";
        rotate = "0";
        break;
      case "diagonal":
        gravity = "center";
        coordinates = "0,0";
        rotate = "-45";
        break;
      case "tiled":
        gravity = "center";
        coordinates = "0,0";
        rotate = "0";
        break;
      default:
        gravity = "center";
        coordinates = "0,0";
        rotate = "0";
    }

    // Build the convert command
    const commandArgs = [inp];
    
    if (position === "tiled") {
      // Tiled watermark
      commandArgs.push(
        "-fill", `rgba(255,255,255,${opacity})`,
        "-font", "Helvetica",
        "-pointsize", fontSize,
        "-gravity", "center",
        "-draw", `text 0,0 "${watermarkText.replace(/"/g, '\\"')}"`,
        "-virtual-pixel", "tile",
        "-blur", "0x3",
        "-fill", `rgba(0,0,0,${opacity})`,
        "-draw", `text 5,5 "${watermarkText.replace(/"/g, '\\"')}"`,
        out
      );
    } else {
      // Single watermark
      commandArgs.push(
        "-fill", `rgba(255,255,255,${opacity})`,
        "-font", "Helvetica",
        "-pointsize", fontSize,
        "-gravity", gravity,
        "-draw", `rotate ${rotate} text ${coordinates} "${watermarkText.replace(/"/g, '\\"')}"`,
        "-blur", "0x2",
        "-fill", `rgba(0,0,0,${opacity})`,
        "-draw", `rotate ${rotate} text ${coordinates} "${watermarkText.replace(/"/g, '\\"')}"`,
        out
      );
    }

    console.log("Executing convert command with args:", commandArgs);
    await run("convert", commandArgs);

    console.log(`Watermark added successfully: ${out}`);

  } catch (error) {
    console.error("Image watermark failed:", error);
    throw new Error(`Failed to add watermark to image: ${error.message}`);
  }
},

"image-to-svg": async (inp, out) => {
  try {
    console.log(`Converting image to SVG: ${inp} -> ${out}`);
    
    // First, ensure the image is in a format potrace can handle (PNG)
    const tempPng = path.join(os.tmpdir(), `${uuidv4()}.png`);
    
    // Convert to PNG first if needed
    const inputExt = path.extname(inp).toLowerCase();
    if (inputExt !== '.png') {
      await run("convert", [inp, tempPng]);
      inp = tempPng; // Use the converted PNG
    }
    
    // Use potrace to convert to SVG
    await run("potrace", [
      inp,
      "--svg", // Explicitly specify SVG output
      "--opttolerance", "0.5", // Optimization tolerance
      "--turdsize", "2", // Remove small artifacts
      "-o", out
    ]);
    
    // Clean up temporary PNG if created
    if (tempPng !== inp && fs.existsSync(tempPng)) {
      await fsp.unlink(tempPng).catch(() => {});
    }
    
    // Verify the output was created
    const stats = await fsp.stat(out);
    if (!stats || stats.size === 0) {
      throw new Error("SVG conversion failed - output file is empty");
    }
    
    console.log(`SVG created successfully: ${stats.size} bytes`);
    return out;
    
  } catch (error) {
    console.error("Image to SVG conversion failed:", error);
    
    // Fallback: Try using ImageMagick if potrace fails
    try {
      console.log("Trying ImageMagick fallback for SVG conversion...");
      await run("convert", [
        inp,
        out
      ]);
      
      const stats = await fsp.stat(out);
      if (stats && stats.size > 0) {
        console.log("SVG created successfully with ImageMagick fallback");
        return out;
      }
    } catch (fallbackError) {
      console.error("ImageMagick fallback also failed:", fallbackError);
    }
    
    throw new Error(`Failed to convert image to SVG: ${error.message}`);
  }
},

"crop-image": async (inputPath, outputPath, req) => {
  let { cropX, cropY, cropWidth, cropHeight } = req.body;
  let x = parseInt(cropX, 10) || 0;
  let y = parseInt(cropY, 10) || 0;
  let width = parseInt(cropWidth, 10) || 100;
  let height = parseInt(cropHeight, 10) || 100;

  const image = sharp(inputPath);
  const meta = await image.metadata();

  if (x < 0 || y < 0 || width < 1 || height < 1) {
    throw new Error("Invalid crop dimensions");
  }

  // clamp to bounds
  if (x + width > meta.width) width = meta.width - x;
  if (y + height > meta.height) height = meta.height - y;

  await image.extract({ left: x, top: y, width, height }).toFile(outputPath);
},

"crop-image": async (inputPath, outputPath, req) => {
  let { cropX, cropY, cropWidth, cropHeight } = req.body;
  
  // Parse and validate inputs
  let x = Math.max(0, parseInt(cropX, 10) || 0);
  let y = Math.max(0, parseInt(cropY, 10) || 0);
  let width = Math.max(1, parseInt(cropWidth, 10) || 100);
  let height = Math.max(1, parseInt(cropHeight, 10) || 100);

  const image = sharp(inputPath);
  const meta = await image.metadata();

  // Clamp to image bounds
  if (x >= meta.width) x = 0;
  if (y >= meta.height) y = 0;
  if (x + width > meta.width) width = meta.width - x;
  if (y + height > meta.height) height = meta.height - y;

  await image.extract({ left: x, top: y, width, height }).toFile(outputPath);
},
"image-to-webp": async (inp, out) => {
  await run("cwebp", [
    "-q", "80",
    inp,
    "-o", out
  ]);
},

"svg-to-pdf": async (inp, out) => {
  try {
    console.log(`Converting SVG to PDF: ${inp} -> ${out}`);
    
    // Check if input file exists
    if (!fs.existsSync(inp)) {
      throw new Error("Input SVG file not found");
    }
    
    // First try with Inkscape (best quality)
    try {
      await run("inkscape", [
        inp,
        "--export-filename=" + out,
        "--export-type=pdf",
        "--export-area-drawing" // Export only the drawing area
      ]);
    } catch (inkscapeError) {
      console.log("Inkscape failed, trying ImageMagick fallback:", inkscapeError.message);
      
      // Fallback to ImageMagick if Inkscape is not available
      await run("convert", [
        "-density", "300", // High resolution for vector conversion
        "-background", "white",
        inp,
        out
      ]);
    }
    
    // Verify the output was created
    const stats = await fsp.stat(out);
    if (!stats || stats.size === 0) {
      throw new Error("PDF conversion failed - output file is empty");
    }
    
    console.log(`PDF created successfully: ${stats.size} bytes`);
    return out;
    
  } catch (error) {
    console.error("SVG to PDF conversion failed:", error);
    
    // Additional fallback: Try using CairoSVG if available
    try {
      console.log("Trying CairoSVG fallback...");
      await run("cairosvg", [
        inp,
        "-o", out,
        "--dpi", "300"
      ]);
      
      const stats = await fsp.stat(out);
      if (stats && stats.size > 0) {
        console.log("PDF created successfully with CairoSVG fallback");
        return out;
      }
    } catch (cairoError) {
      console.error("CairoSVG fallback also failed:", cairoError.message);
    }
    
    throw new Error(`Failed to convert SVG to PDF: ${error.message}`);
  }
},

      // OCR Image to Excel - Extract tabular data from images (FIXED VERSION)
  "ocr-image-to-excel": async (inp, out, req) => {
    try {
      console.log(`Converting Image to Excel via OCR: ${inp} -> ${out}`);
      
      // Check if input file exists
      if (!fs.existsSync(inp)) {
        throw new Error("Input image file not found");
      }
      
      // Ensure output has .xlsx extension
      if (!out.toLowerCase().endsWith('.xlsx')) {
        out = out + '.xlsx';
      }
      
      // Get the original file info from the request to validate file type
      let isValidImage = false;
      let originalFileName = '';
      
      if (req && req.files && req.files.length > 0) {
        const uploadedFile = req.files[0];
        originalFileName = uploadedFile.originalname || '';
        const originalExt = path.extname(originalFileName).toLowerCase();
        const validExtensions = ['.jpg', '.jpeg', '.png', '.bmp', '.tiff', '.tif', '.webp'];
        
        if (validExtensions.includes(originalExt)) {
          isValidImage = true;
          console.log(`Valid image file detected: ${originalFileName}`);
        } else {
          console.log(`Invalid file extension: ${originalExt}`);
        }
      }
      
      // Also check the actual file content as fallback
      if (!isValidImage) {
        try {
          // Try to read the file as image using sharp
          const image = sharp(inp);
          const metadata = await image.metadata();
          console.log(`File metadata: format=${metadata.format}, width=${metadata.width}, height=${metadata.height}`);
          
          if (metadata.format && ['jpeg', 'png', 'webp', 'tiff', 'bmp'].includes(metadata.format)) {
            isValidImage = true;
            console.log(`Valid image format detected via metadata: ${metadata.format}`);
          }
        } catch (sharpError) {
          console.log('Sharp could not read file as image:', sharpError.message);
        }
      }
      
      if (!isValidImage) {
        throw new Error("Uploaded file is not a supported image format. Supported formats: JPG, JPEG, PNG, BMP, TIFF, WEBP");
      }
      
      console.log("Starting advanced OCR table extraction...");
      
      // Try advanced table extraction first
      try {
        await extractTableFromImageToExcel(inp, out);
      } catch (advancedError) {
        console.log("Advanced OCR failed, trying simple approach:", advancedError.message);
        
        // Fallback to simple OCR
        try {
          const success = await simpleImageToExcel(inp, out);
          if (!success) {
            throw new Error("Simple OCR also failed");
          }
        } catch (simpleError) {
          console.log("Simple OCR failed:", simpleError.message);
          throw new Error(`All OCR methods failed: ${simpleError.message}`);
        }
      }
      
      // Verify the output was created
      const stats = await fsp.stat(out);
      if (!stats || stats.size === 0) {
        throw new Error("Excel conversion failed - output file is empty");
      }
      
      console.log(`Excel file created successfully: ${stats.size} bytes`);
      return out;
      
    } catch (error) {
      console.error("OCR Image to Excel conversion failed:", error);
      
      // Create error Excel file with more specific error message
      const pythonPath = "/app/pdfenv/bin/python3";
      const errorScript = `
import pandas as pd
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill

wb = Workbook()
ws = wb.active
ws.title = "Conversion_Report"

# Title
ws['A1'] = "OCR Image to Excel Conversion Failed"
ws['A1'].font = Font(bold=True, size=14, color="FF0000")

# Error Details
ws['A3'] = "Error Details:"
ws['A3'].font = Font(bold=True)
ws['A4'] = "${error.message.replace(/"/g, '\\"').replace(/\\n/g, ' ')}"

# File Information
ws['A6'] = "File Information:"
ws['A6'].font = Font(bold=True)
ws['A7'] = "Uploaded file: ${req && req.files && req.files[0] ? req.files[0].originalname : 'Unknown'}"
ws['A8'] = "File path: ${inp}"

# Possible Reasons
ws['A10'] = "Possible Reasons:"
ws['A10'].font = Font(bold=True)
ws['A11'] = "1. File format not supported (required: JPG, PNG, BMP, TIFF, WEBP)"
ws['A12'] = "2. File may be corrupted or unreadable"
ws['A13'] = "3. File extension doesn't match actual format"
ws['A14'] = "4. Server cannot process the uploaded file"

# Solutions
ws['A16'] = "Solutions:"
ws['A16'].font = Font(bold=True)
ws['A17'] = "1. Ensure you're uploading a valid image file"
ws['A18'] = "2. Try converting the image to JPG or PNG format first"
ws['A19'] = "3. Check if the file opens in image viewer software"
ws['A20'] = "4. Try a different image file"

# Auto-adjust column widths
for column in ['A', 'B', 'C', 'D', 'E', 'F']:
    ws.column_dimensions[column].width = 20

wb.save("${out}")
`;
      
      const scriptPath = path.join(os.tmpdir(), `error_excel_${uuidv4()}.py`);
      await fsp.writeFile(scriptPath, errorScript);
      await run(pythonPath, [scriptPath]);
      
      return out;
    }
  },

// Archive Converters

"tar-to-zip": async (inp, out) => {
  try {
    console.log(`Converting TAR to ZIP: ${inp} -> ${out}`);
    
    // Check if input file exists
    if (!fs.existsSync(inp)) {
      throw new Error("Input TAR file not found");
    }
    
    // Ensure output has .zip extension
    if (!out.toLowerCase().endsWith('.zip')) {
      out = out + '.zip';
    }
    
    // Create a temporary directory to extract files
    const tempDir = path.join(os.tmpdir(), `tar_to_zip_${uuidv4()}`);
    await fsp.mkdir(tempDir, { recursive: true });
    
    console.log(`Extracting TAR to temporary directory: ${tempDir}`);
    
    // Extract TAR file
    await tar.x({
      file: inp,
      cwd: tempDir
    });
    
    // Create ZIP archive
    const zip = new AdmZip();
    
    // Recursively add all files to ZIP
    const addFilesToZip = (dirPath, zipPath = '') => {
      const files = fsp.readdirSync(dirPath);
      
      files.forEach(file => {
        const fullPath = path.join(dirPath, file);
        const relativePath = path.join(zipPath, file);
        
        if (fsp.statSync(fullPath).isDirectory()) {
          // Add directory entry
          zip.addFile(relativePath + '/', Buffer.alloc(0));
          addFilesToZip(fullPath, relativePath);
        } else {
          // Add file
          const fileData = fsp.readFileSync(fullPath);
          zip.addFile(relativePath, fileData);
        }
      });
    };
    
    addFilesToZip(tempDir);
    
    // Write ZIP file
    zip.writeZip(out);
    
    // Clean up temporary directory
    await fsp.rm(tempDir, { recursive: true, force: true });
    
    // Verify the output was created
    const stats = await fsp.stat(out);
    if (!stats || stats.size === 0) {
      throw new Error("ZIP conversion failed - output file is empty");
    }
    
    console.log(`ZIP created successfully: ${stats.size} bytes`);
    return out;
    
  } catch (error) {
    console.error("TAR to ZIP conversion failed:", error);
    
    // Fallback: Try Python-based conversion
    try {
      console.log("Trying Python fallback for TAR to ZIP...");
      const pythonPath = "python3";
      
      const pythonScript = `
import sys
import os
import tarfile
import zipfile
import tempfile
import shutil

def convert_tar_to_zip(input_path, output_path):
    try:
        # Check if input exists
        if not os.path.exists(input_path):
            return False, "Input file does not exist"
        
        # Create temporary directory
        temp_dir = tempfile.mkdtemp()
        
        try:
            # Extract TAR file
            with tarfile.open(input_path, 'r') as tar_ref:
                tar_ref.extractall(temp_dir)
            
            # Create ZIP file
            with zipfile.ZipFile(output_path, 'w', zipfile.ZIP_DEFLATED) as zip_ref:
                for root, dirs, files in os.walk(temp_dir):
                    for file in files:
                        file_path = os.path.join(root, file)
                        # Preserve directory structure
                        arcname = os.path.relpath(file_path, temp_dir)
                        zip_ref.write(file_path, arcname)
            
            # Verify output
            if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
                return True, "Conversion successful"
            else:
                return False, "Output file was not created"
                
        finally:
            # Clean up temporary directory
            shutil.rmtree(temp_dir, ignore_errors=True)
            
    except Exception as e:
        return False, f"Error: {str(e)}"

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("ERROR: Usage: python_script.py <input> <output>")
        sys.exit(1)
    
    success, message = convert_tar_to_zip(sys.argv[1], sys.argv[2])
    if success:
        print("SUCCESS:" + message)
    else:
        print("ERROR:" + message)
        sys.exit(1)
`;
      
      const scriptPath = path.join(os.tmpdir(), `tar_to_zip_${uuidv4()}.py`);
      await fsp.writeFile(scriptPath, pythonScript);
      
      const { stdout, stderr } = await run(pythonPath, [
        scriptPath,
        inp,
        out
      ]);
      
      // Clean up temporary script
      await fsp.unlink(scriptPath).catch(() => {});
      
      if (stdout.includes("SUCCESS:")) {
        console.log("TAR to ZIP succeeded via Python fallback");
        return out;
      } else {
        throw new Error(stdout.includes("ERROR:") ? stdout.split("ERROR:")[1].trim() : "Python conversion failed");
      }
      
    } catch (fallbackError) {
      console.error("Python fallback also failed:", fallbackError);
    }
    
    throw new Error(`Failed to convert TAR to ZIP: ${error.message}`);
  }
},


"unzip": async (inp, outDir) => {
  await run("unzip", [inp, "-d", outDir]);
},

"compress-archive": async (inp, out) => {
  const ext = path.extname(out).toLowerCase();
  if (ext === '.zip') {
    await run("zip", ["-9", out, inp]);
  } else if (ext === '.tar.gz') {
    await run("tar", ["-czf", out, inp]);
  }
},

// Add to your converters object
"merge-images-to-pdf": async (inputs, out) => {
  try {
    console.log(`Merging ${inputs.length} images to PDF: ${out}`);
    
    // Use ImageMagick to convert images to PDF
    const args = [...inputs, out];
    await run("convert", args);
    
    // Verify the output was created
    const stats = await fsp.stat(out);
    if (!stats || stats.size === 0) {
      throw new Error("PDF merge failed - output file is empty");
    }
    
    console.log(`PDF created successfully: ${stats.size} bytes`);
    return out;
    
  } catch (error) {
    console.error("Image to PDF merge failed:", error);
    throw new Error(`Failed to merge images to PDF: ${error.message}`);
  }
},

"extract-pdf-images": async (inp, out, req) => {
  const format = (req?.body?.format || "original").toLowerCase();
  const quality = (req?.body?.quality || "medium").toLowerCase();
  
  console.log(`=== STARTING PDF IMAGE EXTRACTION ===`);
  console.log(`Input: ${inp}`);
  console.log(`Output: ${out}`);
  console.log(`Format: ${format}, Quality: ${quality}`);

  // Temp dir for extracted images
  const imgDir = path.join(os.tmpdir(), uuidv4());
  await fsp.mkdir(imgDir, { recursive: true });
  console.log(`Temp directory: ${imgDir}`);

  try {
    // Use pdfimages to extract images from PDF
    const args = ["-all", inp, path.join(imgDir, "image")];
    console.log(`Running: pdfimages ${args.join(' ')}`);
    
    await run("pdfimages", args);
    console.log(`pdfimages completed successfully`);

    // Collect extracted images
    const allFiles = await fsp.readdir(imgDir);
    console.log(`All files in temp dir: ${allFiles.join(', ')}`);
    
    const files = allFiles.filter(f => {
      const ext = path.extname(f).toLowerCase();
      return ['.ppm', '.pbm', '.pgm', '.png', '.jpg', '.jpeg', '.tiff', '.bmp'].includes(ext);
    });

    console.log(`Found ${files.length} image files: ${files.join(', ')}`);

    if (files.length === 0) {
      throw new Error("No images found in the PDF");
    }

    // Convert images if requested format is not original
    const convertedFiles = [];
    if (format !== "original") {
      for (const file of files) {
        const inputPath = path.join(imgDir, file);
        const outputFile = path.basename(file, path.extname(file)) + `.${format}`;
        const outputPath = path.join(imgDir, outputFile);
        
        // Set quality based on user selection
        let qualityOption = "";
        if (format === "jpg" || format === "jpeg") {
          switch(quality) {
            case "high": qualityOption = "-quality 95"; break;
            case "medium": qualityOption = "-quality 80"; break;
            case "low": qualityOption = "-quality 65"; break;
          }
        }
        
        await run("convert", [
          inputPath,
          ...(qualityOption ? qualityOption.split(" ") : []),
          outputPath
        ]);
        
        convertedFiles.push(outputPath);
        // Remove original extracted file
        await fsp.unlink(inputPath).catch(() => {});
      }
    } else {
      // Keep original files
      convertedFiles.push(...files.map(f => path.join(imgDir, f)));
    }

    if (convertedFiles.length === 0) {
      throw new Error("No valid images found after processing");
    }

    console.log(`Packaging ${convertedFiles.length} images into ZIP`);
    
    // Zip images into output - FIXED: Use proper Promise handling
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(out);
      const archive = archiver("zip", { zlib: { level: 9 } });
      
      output.on('close', () => {
        console.log(`ZIP created successfully: ${archive.pointer()} total bytes`);
        resolve();
      });
      
      output.on('error', (err) => {
        console.error('ZIP creation error:', err);
        reject(err);
      });
      
      archive.on('error', (err) => {
        console.error('Archiver error:', err);
        reject(err);
      });
      
      archive.pipe(output);
      
      convertedFiles.forEach(f => {
        const fileName = path.basename(f);
        console.log(`Adding to ZIP: ${fileName}`);
        archive.file(f, { name: fileName });
      });
      
      archive.finalize();
    });

    console.log(`Successfully extracted ${convertedFiles.length} images`);
    
  } catch (error) {
    console.error("Image extraction failed:", error);
    throw new Error(`Failed to extract images: ${error.message}`);
  } finally {
    // Clean up temp directory
    await fsp.rm(imgDir, { recursive: true }).catch(() => {});
    console.log(`=== EXTRACTION COMPLETED ===`);
  }
},


// Ebook Converters
// Add to your converters object
"mobi-to-epub": async (inp, out) => {
  try {
    console.log(`Converting MOBI to EPUB: ${inp} -> ${out}`);
    
    // Check if input file exists
    if (!fs.existsSync(inp)) {
      throw new Error("Input MOBI file not found");
    }
    
    // Ensure output has .epub extension
    if (!out.toLowerCase().endsWith('.epub')) {
      out = out + '.epub';
    }
    
    // Create a temporary file with .mobi extension for ebook-convert
    const tempMobiPath = path.join(os.tmpdir(), `${uuidv4()}.mobi`);
    await fsp.copyFile(inp, tempMobiPath);
    
    console.log(`Using temporary MOBI file: ${tempMobiPath}`);
    
    // Use ebook-convert from Calibre
    await run("ebook-convert", [
      tempMobiPath,
      out
    ]);
    
    // Clean up temporary file
    await fsp.unlink(tempMobiPath).catch(() => {});
    
    // Verify the output was created
    const stats = await fsp.stat(out);
    if (!stats || stats.size === 0) {
      throw new Error("EPUB conversion failed - output file is empty");
    }
    
    console.log(`EPUB created successfully: ${stats.size} bytes`);
    return out;
    
  } catch (error) {
    console.error("MOBI to EPUB conversion failed:", error);
    
    // Fallback: Try Python-based conversion
    try {
      console.log("Trying Python fallback for MOBI to EPUB...");
      const pythonPath = "/app/pdfenv/bin/python3";
      
      const pythonScript = `
import sys
import os
import tempfile
import subprocess

def convert_mobi_to_epub(input_path, output_path):
    try:
        # Check if input exists
        if not os.path.exists(input_path):
            return False, "Input file does not exist"
        
        # Use ebook-convert with proper file extensions
        result = subprocess.run([
            "ebook-convert", 
            input_path, 
            output_path
        ], capture_output=True, text=True, timeout=300)
        
        if result.returncode == 0:
            if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
                return True, "Conversion successful"
            else:
                return False, "Output file was not created"
        else:
            return False, f"Conversion failed: {result.stderr}"
            
    except Exception as e:
        return False, f"Error: {str(e)}"

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("ERROR: Usage: python_script.py <input> <output>")
        sys.exit(1)
    
    success, message = convert_mobi_to_epub(sys.argv[1], sys.argv[2])
    if success:
        print("SUCCESS:" + message)
    else:
        print("ERROR:" + message)
        sys.exit(1)
`;
      
      const scriptPath = path.join(os.tmpdir(), `mobi_to_epub_${uuidv4()}.py`);
      await fsp.writeFile(scriptPath, pythonScript);
      
      // Create temporary files with proper extensions
      const tempMobiPath = path.join(os.tmpdir(), `${uuidv4()}.mobi`);
      const tempEpubPath = path.join(os.tmpdir(), `${uuidv4()}.epub`);
      
      await fsp.copyFile(inp, tempMobiPath);
      
      const { stdout, stderr } = await run(pythonPath, [
        scriptPath,
        tempMobiPath,
        tempEpubPath
      ]);
      
      // Clean up temporary files
      await fsp.unlink(scriptPath).catch(() => {});
      await fsp.unlink(tempMobiPath).catch(() => {});
      
      if (stdout.includes("SUCCESS:")) {
        await fsp.rename(tempEpubPath, out);
        console.log("MOBI to EPUB succeeded via Python fallback");
        return out;
      } else {
        await fsp.unlink(tempEpubPath).catch(() => {});
        throw new Error(stdout.includes("ERROR:") ? stdout.split("ERROR:")[1].trim() : "Python conversion failed");
      }
      
    } catch (fallbackError) {
      console.error("Python fallback also failed:", fallbackError);
    }
    
    throw new Error(`Failed to convert MOBI to EPUB: ${error.message}`);
  }
},

// Add to your converters object
"zip-to-tar": async (inp, out) => {
  try {
    console.log(`Converting ZIP to TAR: ${inp} -> ${out}`);
    
    // Check if input file exists
    if (!fs.existsSync(inp)) {
      throw new Error("Input ZIP file not found");
    }
    
    // Ensure output has .tar extension
    if (!out.toLowerCase().endsWith('.tar')) {
      out = out + '.tar';
    }
    
    // Read the ZIP file
    const zip = new AdmZip(inp);
    const zipEntries = zip.getEntries();
    
    // Create a temporary directory to extract files
    const tempDir = path.join(os.tmpdir(), `zip_to_tar_${uuidv4()}`);
    await fsp.mkdir(tempDir, { recursive: true });
    
    console.log(`Extracting ZIP to temporary directory: ${tempDir}`);
    
    // Extract all files from ZIP
    zip.extractAllTo(tempDir, true);
    
    // Create TAR archive
    const filesToTar = [];
    
    // Recursively get all files in the directory
    const getAllFiles = (dirPath, arrayOfFiles = []) => {
      const files = fsp.readdirSync(dirPath);
      
      files.forEach(file => {
        const fullPath = path.join(dirPath, file);
        if (fsp.statSync(fullPath).isDirectory()) {
          arrayOfFiles = getAllFiles(fullPath, arrayOfFiles);
        } else {
          arrayOfFiles.push(fullPath);
        }
      });
      
      return arrayOfFiles;
    };
    
    const allFiles = getAllFiles(tempDir);
    
    // Create TAR file
    await tar.c(
      {
        gzip: false,
        file: out,
        cwd: tempDir
      },
      allFiles.map(file => path.relative(tempDir, file))
    );
    
    // Clean up temporary directory
    await fsp.rm(tempDir, { recursive: true, force: true });
    
    // Verify the output was created
    const stats = await fsp.stat(out);
    if (!stats || stats.size === 0) {
      throw new Error("TAR conversion failed - output file is empty");
    }
    
    console.log(`TAR created successfully: ${stats.size} bytes`);
    return out;
    
  } catch (error) {
    console.error("ZIP to TAR conversion failed:", error);
    
    // Fallback: Try Python-based conversion
    try {
      console.log("Trying Python fallback for ZIP to TAR...");
      const pythonPath = "python3";
      
      const pythonScript = `
import sys
import os
import tarfile
import zipfile
import tempfile
import shutil

def convert_zip_to_tar(input_path, output_path):
    try:
        # Check if input exists
        if not os.path.exists(input_path):
            return False, "Input file does not exist"
        
        # Create temporary directory
        temp_dir = tempfile.mkdtemp()
        
        try:
            # Extract ZIP file
            with zipfile.ZipFile(input_path, 'r') as zip_ref:
                zip_ref.extractall(temp_dir)
            
            # Create TAR file
            with tarfile.open(output_path, 'w') as tar_ref:
                tar_ref.add(temp_dir, arcname='')
            
            # Verify output
            if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
                return True, "Conversion successful"
            else:
                return False, "Output file was not created"
                
        finally:
            # Clean up temporary directory
            shutil.rmtree(temp_dir, ignore_errors=True)
            
    except Exception as e:
        return False, f"Error: {str(e)}"

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("ERROR: Usage: python_script.py <input> <output>")
        sys.exit(1)
    
    success, message = convert_zip_to_tar(sys.argv[1], sys.argv[2])
    if success:
        print("SUCCESS:" + message)
    else:
        print("ERROR:" + message)
        sys.exit(1)
`;
      
      const scriptPath = path.join(os.tmpdir(), `zip_to_tar_${uuidv4()}.py`);
      await fsp.writeFile(scriptPath, pythonScript);
      
      const { stdout, stderr } = await run(pythonPath, [
        scriptPath,
        inp,
        out
      ]);
      
      // Clean up temporary script
      await fsp.unlink(scriptPath).catch(() => {});
      
      if (stdout.includes("SUCCESS:")) {
        console.log("ZIP to TAR succeeded via Python fallback");
        return out;
      } else {
        throw new Error(stdout.includes("ERROR:") ? stdout.split("ERROR:")[1].trim() : "Python conversion failed");
      }
      
    } catch (fallbackError) {
      console.error("Python fallback also failed:", fallbackError);
    }
    
    throw new Error(`Failed to convert ZIP to TAR: ${error.message}`);
  }
},

// Spreadsheet Converters
"csv-to-excel": async (inp, out) => {
  try {
    // First try LibreOffice
    await run("soffice", [
        "--headless",
        "--convert-to", "xlsx",
        inp,
        "--outdir", path.dirname(out)
    ]);
    
    const gen = path.join(path.dirname(out), path.basename(inp, path.extname(inp)) + ".xlsx");
    
    // Check if LibreOffice conversion worked
    if (fs.existsSync(gen)) {
      await fsp.rename(gen, out);
      return;
    }
    
    throw new Error("LibreOffice conversion failed");
    
  } catch (error) {
    console.log("LibreOffice failed, trying Python fallback...");
    
    // Fallback to Python pandas using your custom Python path
    const pythonPath = "/app/pdfenv/bin/python3";
    
    await run(pythonPath, [
        "-c",
        `import pandas as pd; pd.read_csv('${inp}').to_excel('${out}', index=False)`
    ]);
  }
},

"xls-to-xlsx": async (inp, out) => {
  await run("soffice", [
    "--headless",
    "--convert-to", "xlsx",
    inp,
    "--outdir", path.dirname(out)
  ]);
  const gen = path.join(path.dirname(out), path.basename(inp, path.extname(inp)) + ".xlsx");
  await fsp.rename(gen, out);
},

"xlsx-to-xls": async (inp, out) => {
  await run("soffice", [
    "--headless",
    "--convert-to", "xls",
    inp,
    "--outdir", path.dirname(out)
  ]);
  const gen = path.join(path.dirname(out), path.basename(inp, path.extname(inp)) + ".xls");
  await fsp.rename(gen, out);
},


// OCR Operations


"ocr-image-to-word": async (inp, out, req) => {
  const language = (req && req.query && req.query.language) || 'eng';
  const pythonPath = "/app/pdfenv/bin/python3";
  const tempDir = path.join(os.tmpdir(), uuidv4());
  
  try {
      await fsp.mkdir(tempDir);
      console.log(`Starting image to Word conversion for: ${inp}, language: ${language}`);

      // Get the base output name without extension
      const outputBase = out.replace('.docx', '');
      
      // Run Tesseract OCR
      await run("tesseract", [
          inp,
          outputBase, // Output base name without extension
          "-l", language,
          "docx"
      ]);

      // Tesseract automatically adds .docx extension, so we need to check both possibilities
      const possibleOutputs = [
          out, // Original expected path
          outputBase + '.docx', // What Tesseract actually creates
          path.join(path.dirname(out), path.basename(outputBase) + '.docx') // Alternative path
      ];

      let outputCreated = null;
      for (const possibleOutput of possibleOutputs) {
          if (fs.existsSync(possibleOutput)) {
              outputCreated = possibleOutput;
              break;
          }
      }

      if (!outputCreated) {
          throw new Error("Tesseract did not create output file");
      }

      // If the output is not at the expected location, move it
      if (outputCreated !== out) {
          await fsp.rename(outputCreated, out);
      }

      // Verify the output has content
      const stats = await fsp.stat(out);
      if (stats.size === 0) {
          throw new Error("Conversion produced empty document");
      }
      
      console.log("Image to Word conversion completed successfully");
      
  } catch (error) {
      console.error("Image to Word conversion failed:", error);
      
      // Fallback: Try OCR to text first, then create Word document
      try {
          console.log("Trying fallback text extraction method...");
          const extractedText = path.join(tempDir, "content.txt");
          
          // OCR to text first
          await run("tesseract", [
              inp,
              extractedText.replace('.txt', ''),
              "-l", language,
              "txt"
          ]);

          // Create Word document from extracted text
          const pythonScript = `
from docx import Document
import re

def create_word_from_text(text_file, output_docx):
  try:
      with open(text_file, 'r', encoding='utf-8', errors='ignore') as f:
          content = f.read()
  except:
      with open(text_file, 'r', encoding='latin-1', errors='ignore') as f:
          content = f.read()
  
  # Clean text
  content = re.sub(r'[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]', '', content)
  content = re.sub(r'\\s+', ' ', content)
  
  # Create document
  doc = Document()
  
  if content.strip():
      paragraphs = [p.strip() for p in content.split('\\n\\n') if p.strip()]
      for para in paragraphs:
          if para:
              doc.add_paragraph(para)
  else:
      doc.add_paragraph("No text could be extracted from the image.")
      doc.add_paragraph("Please try a higher quality image with clear text.")
  
  doc.save(output_docx)

if __name__ == "__main__":
  create_word_from_text("${extractedText}", "${out}")
`;

          const scriptPath = path.join(tempDir, "fallback_docx.py");
          await fsp.writeFile(scriptPath, pythonScript);
          await run(pythonPath, [scriptPath]);
          
          // Verify fallback worked
          const stats = await fsp.stat(out);
          if (stats.size === 0) {
              throw new Error("Fallback conversion also failed");
          }
          
          console.log("Fallback conversion successful");
          
      } catch (fallbackError) {
          console.error("Fallback also failed:", fallbackError);
          
          // Create a simple error document
          const errorScript = `
from docx import Document
doc = Document()
doc.add_paragraph("Conversion completed with issues")
doc.add_paragraph("The image may be low quality or contain handwritten text.")
doc.add_paragraph("For better results, use high-quality images with clear printed text.")
doc.save("${out}")
`;
          const scriptPath = path.join(os.tmpdir(), `error_${uuidv4()}.py`);
          await fsp.writeFile(scriptPath, errorScript);
          await run(pythonPath, [scriptPath]);
          
          throw new Error(`Image to Word conversion failed: ${error.message}`);
      }
  } finally {
      await fsp.rm(tempDir, { recursive: true }).catch(() => {});
  }
},
// Contact Formats

"convert-vcf-to-csv": async (inp, out) => {
  try {
    console.log(`Converting VCF to CSV: ${inp} -> ${out}`);
    
    if (!fs.existsSync(inp)) {
      throw new Error("Input VCF file not found");
    }

    if (!out.toLowerCase().endsWith('.csv')) {
      out = out + '.csv';
    }

    const pythonPath = "/app/pdfenv/bin/python3";

    const pythonScript = `
import csv
import sys
import re

def parse_vcf(file_path):
    contacts = []
    contact = {}
    
    with open(file_path, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            
            if line.startswith("BEGIN:VCARD"):
                contact = {}
            elif line.startswith("END:VCARD"):
                contacts.append(contact)
                contact = {}
            else:
                if ":" in line:
                    parts = line.split(":", 1)
                    key = parts[0].upper()
                    value = parts[1].strip()
                    
                    if key.startswith("FN"):
                        contact["Name"] = value
                    elif key.startswith("TEL"):
                        contact.setdefault("Phone", []).append(value)
                    elif key.startswith("EMAIL"):
                        contact.setdefault("Email", []).append(value)
                    elif key.startswith("ORG"):
                        contact["Org"] = value
                    elif key.startswith("TITLE"):
                        contact["Title"] = value
                    elif key.startswith("ADR"):
                        # ADR format: ADR;TYPE=HOME:;;Street;City;State;ZIP;Country
                        adr_parts = value.split(";")
                        contact["Address"] = " ".join([p for p in adr_parts if p])
                    elif key.startswith("NOTE"):
                        contact.setdefault("Note", []).append(value)
    return contacts

def convert_vcf_to_csv(input_file, output_file):
    try:
        contacts = parse_vcf(input_file)
        
        if not contacts:
            raise ValueError("No contacts found in VCF")
        
        # Determine all possible CSV columns
        headers = ["Name", "Phone", "Email", "Org", "Title", "Address", "Note"]
        
        with open(output_file, "w", newline="", encoding="utf-8") as csvfile:
            writer = csv.DictWriter(csvfile, fieldnames=headers)
            writer.writeheader()
            
            for c in contacts:
                row = {}
                for h in headers:
                    val = c.get(h, "")
                    if isinstance(val, list):
                        row[h] = "; ".join(val)
                    else:
                        row[h] = val
                writer.writerow(row)
        
        print("Successfully converted VCF to CSV")
        return True
    except Exception as e:
        print(f"Conversion error: {str(e)}")
        import traceback
        traceback.print_exc()
        return False

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("ERROR: Usage: python script.py <input.vcf> <output.csv>")
        sys.exit(1)
    
    input_file = sys.argv[1]
    output_file = sys.argv[2]
    
    success = convert_vcf_to_csv(input_file, output_file)
    if success:
        print("SUCCESS: Conversion completed")
        sys.exit(0)
    else:
        print("ERROR: Conversion failed")
        sys.exit(1)
`;

    // Create temporary Python script
    const scriptPath = path.join(os.tmpdir(), `vcf_to_csv_${uuidv4()}.py`);
    await fsp.writeFile(scriptPath, pythonScript);

    console.log(`Running Python script: ${pythonPath} ${scriptPath} ${inp} ${out}`);

    const { stdout, stderr } = await run(pythonPath, [scriptPath, inp, out]);

    console.log("Python stdout:", stdout);
    if (stderr) console.log("Python stderr:", stderr);

    await fsp.unlink(scriptPath).catch(() => {});

    // Verify output CSV
    const stats = await fsp.stat(out);
    if (!stats || stats.size === 0) {
      throw new Error("CSV conversion failed - output file is empty");
    }

    console.log(`CSV created successfully: ${stats.size} bytes`);
    return out;

  } catch (error) {
    console.error("VCF to CSV conversion failed:", error);

    try {
      await run("/app/pdfenv/bin/python3", ["--version"]);
    } catch (pyError) {
      throw new Error("Python is not available at /app/pdfenv/bin/python3");
    }

    throw new Error(`Failed to convert VCF to CSV: ${error.message}`);
  }
},

// --- convert-cbr-to-cbz ---
"convert-cbr-to-cbz": async (inp, out) => {
  try {
    console.log(`convert-cbr-to-cbz: ${inp} -> ${out}`);
    if (!fs.existsSync(inp)) throw new Error("Input file not found");

    // Ensure .cbz extension on output if missing
    if (!String(out).toLowerCase().endsWith(".cbz")) {
      out = out + ".cbz";
    }

    // Make sure output folder exists
    await fsp.mkdir(path.dirname(out), { recursive: true });

    const scriptPath = path.join(process.cwd(), "convert_cbr_to_cbz.py");
    const result = await runPython(scriptPath, [inp, out]);

    console.log("convert-cbr-to-cbz stdout:", result || "(empty)");
    // Verify output
    const stats = await fsp.stat(out);
    if (!stats || stats.size === 0) {
      throw new Error("Output .cbz not created or empty");
    }
    console.log(`CBZ created: ${stats.size} bytes`);
    return out;
  } catch (err) {
    console.error("Conversion failed for convert-cbr-to-cbz:", err);
    throw err;
  }
},


"cbz-to-cbr": async (inp, out) => {
  const { spawn } = require("child_process");
  
  return new Promise((resolve, reject) => {
    // Inline Python code (triple-quoted string)
    const pyCode = `
import sys, os, tempfile, shutil, zipfile
from rarfile import RarFile

def convert_cbz_to_cbr(input_file, output_file):
    if not os.path.exists(input_file):
        raise FileNotFoundError(f"Input file not found: {input_file}")

    if not input_file.lower().endswith(".cbz"):
        raise ValueError("Input file must be a .cbz archive")

    temp_dir = tempfile.mkdtemp()
    try:
        # --- Extract CBZ (ZIP archive) ---
        with zipfile.ZipFile(input_file, "r") as zf:
            zf.extractall(temp_dir)

        # --- Recompress as CBR (RAR archive) ---
        # Note: requires 'rar' command line tool installed
        shutil.make_archive(output_file.replace(".cbr", ""), 'rar', temp_dir)
    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)

if __name__ == "__main__":
    convert_cbz_to_cbr(sys.argv[1], sys.argv[2])
`;

    const py = spawn("/app/pdfenv/bin/python3", ["-u", "-c", pyCode, inp, out]);

    py.stderr.on("data", (data) => {
      console.error("Python error:", data.toString());
    });

    py.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error("CBZ → CBR conversion failed with code " + code));
    });
  });
},


"convert-csv-to-vcf": async (inp, out) => {
  try {
    console.log(`Converting CSV to VCF: ${inp} -> ${out}`);
    
    if (!fs.existsSync(inp)) {
      throw new Error("Input CSV file not found");
    }

    if (!out.toLowerCase().endsWith('.vcf')) {
      out = out + '.vcf';
    }

    const pythonPath = "/app/pdfenv/bin/python3";

    const pythonScript = `
import csv
import sys
import os

def create_vcard(row, headers):
    vcard = ["BEGIN:VCARD", "VERSION:3.0"]

    # Map headers dynamically
    for i, field in enumerate(headers):
        value = row[i].strip() if i < len(row) else ""
        if not value:
            continue
        
        field_lower = field.lower()
        
        if "name" in field_lower:
            vcard.append(f"FN:{value}")
        elif "phone" in field_lower or "mobile" in field_lower:
            vcard.append(f"TEL;TYPE=CELL:{value}")
        elif "email" in field_lower:
            vcard.append(f"EMAIL;TYPE=INTERNET:{value}")
        elif "org" in field_lower or "company" in field_lower:
            vcard.append(f"ORG:{value}")
        elif "title" in field_lower:
            vcard.append(f"TITLE:{value}")
        elif "address" in field_lower:
            vcard.append(f"ADR;TYPE=HOME:;;{value}")
        else:
            # Any other field goes into NOTE
            vcard.append(f"NOTE:{field}:{value}")

    vcard.append("END:VCARD")
    return "\\n".join(vcard)

def convert_csv_to_vcf(input_file, output_file):
    try:
        with open(input_file, "r", encoding="utf-8-sig") as csvfile:
            reader = csv.reader(csvfile)
            headers = next(reader, None)
            
            if not headers:
                raise ValueError("CSV file has no header row")

            vcards = []
            for row in reader:
                if any(row):  # skip empty rows
                    vcards.append(create_vcard(row, headers))
            
            with open(output_file, "w", encoding="utf-8") as vcf_file:
                vcf_file.write("\\n".join(vcards))
        
        print("Successfully converted CSV to VCF")
        return True
    except Exception as e:
        print(f"Conversion error: {str(e)}")
        import traceback
        traceback.print_exc()
        return False

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("ERROR: Usage: python script.py <input.csv> <output.vcf>")
        sys.exit(1)
    
    input_file = sys.argv[1]
    output_file = sys.argv[2]
    
    success = convert_csv_to_vcf(input_file, output_file)
    if success:
        print("SUCCESS: Conversion completed")
        sys.exit(0)
    else:
        print("ERROR: Conversion failed")
        sys.exit(1)
`;

    // Create temporary Python script
    const scriptPath = path.join(os.tmpdir(), `csv_to_vcf_${uuidv4()}.py`);
    await fsp.writeFile(scriptPath, pythonScript);

    console.log(`Running Python script: ${pythonPath} ${scriptPath} ${inp} ${out}`);

    const { stdout, stderr } = await run(pythonPath, [scriptPath, inp, out]);

    console.log("Python stdout:", stdout);
    if (stderr) console.log("Python stderr:", stderr);

    await fsp.unlink(scriptPath).catch(() => {});

    // Verify output VCF
    const stats = await fsp.stat(out);
    if (!stats || stats.size === 0) {
      throw new Error("VCF conversion failed - output file is empty");
    }

    console.log(`VCF created successfully: ${stats.size} bytes`);
    return out;

  } catch (error) {
    console.error("CSV to VCF conversion failed:", error);

    try {
      await run("/app/pdfenv/bin/python3", ["--version"]);
    } catch (pyError) {
      throw new Error("Python is not available at /app/pdfenv/bin/python3");
    }

    throw new Error(`Failed to convert CSV to VCF: ${error.message}`);
  }
},


// ISO Operations
"convert-iso-to-zip": async (inp, out) => {
  const tempDir = path.join(os.tmpdir(), uuidv4());
  await fsp.mkdir(tempDir);
  await run("7z", ["x", inp, `-o${tempDir}`]);
  await run("zip", ["-r", out, "."], { cwd: tempDir });
  await fsp.rm(tempDir, { recursive: true });
},

"convert-zip-to-iso": async (inp, out) => {
  const tempDir = path.join(os.tmpdir(), uuidv4());
  await fsp.mkdir(tempDir);
  await run("unzip", [inp, "-d", tempDir]);
  await run("genisoimage", [
    "-o", out,
    "-J", "-r", "-V", "DATA_DISK",
    tempDir
  ]);
  await fsp.rm(tempDir, { recursive: true });
},

// Data Format Converters

"json-to-csv": async (inp, out) => {
  try {
    console.log(`Converting JSON to CSV: ${inp} -> ${out}`);
    
    // Check if input file exists
    if (!fs.existsSync(inp)) {
      throw new Error("Input JSON file not found");
    }
    
    // Ensure output has .csv extension
    if (!out.toLowerCase().endsWith('.csv')) {
      out = out + '.csv';
    }
    
    const pythonPath = "/app/pdfenv/bin/python3";
    
    // Python script for JSON to CSV conversion
    const pythonScript = `
import json
import csv
import sys

def convert_json_to_csv(input_file, output_file):
    try:
        # Read JSON file
        with open(input_file, 'r', encoding='utf-8') as f:
            data = json.load(f)
        
        # Check if data is an array
        if not isinstance(data, list):
            raise ValueError("JSON data must be an array of objects")
        
        if len(data) == 0:
            raise ValueError("JSON array is empty")
        
        # Get all unique keys from all objects
        all_keys = set()
        for item in data:
            if isinstance(item, dict):
                all_keys.update(item.keys())
        
        if not all_keys:
            raise ValueError("No valid data found in JSON array")
        
        headers = list(all_keys)
        
        # Write CSV file
        with open(output_file, 'w', encoding='utf-8', newline='') as f:
            writer = csv.DictWriter(f, fieldnames=headers)
            writer.writeheader()
            
            for item in data:
                if isinstance(item, dict):
                    # Clean the data - convert non-serializable values to strings
                    cleaned_item = {}
                    for key, value in item.items():
                        if value is None:
                            cleaned_item[key] = ''
                        elif isinstance(value, (dict, list)):
                            cleaned_item[key] = json.dumps(value)
                        else:
                            cleaned_item[key] = str(value)
                    writer.writerow(cleaned_item)
        
        print(f"Successfully converted {len(data)} records to CSV")
        return True
        
    except Exception as e:
        print(f"Error: {str(e)}")
        return False

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python script.py <input.json> <output.csv>")
        sys.exit(1)
    
    success = convert_json_to_csv(sys.argv[1], sys.argv[2])
    sys.exit(0 if success else 1)
`;
    
    // Create temporary Python script
    const scriptPath = path.join(os.tmpdir(), `json_to_csv_${uuidv4()}.py`);
    await fsp.writeFile(scriptPath, pythonScript);
    
    console.log(`Running Python script: ${pythonPath} ${scriptPath} ${inp} ${out}`);
    
    // Execute Python script
    await run(pythonPath, [scriptPath, inp, out]);
    
    // Clean up temporary script
    await fsp.unlink(scriptPath).catch(() => {});
    
    // Verify the output was created
    const stats = await fsp.stat(out);
    if (!stats || stats.size === 0) {
      throw new Error("CSV conversion failed - output file is empty");
    }
    
    console.log(`CSV created successfully: ${stats.size} bytes`);
    return out;
    
  } catch (error) {
    console.error("JSON to CSV conversion failed:", error);
    
    // Check if Python is available
    try {
      await run("/app/pdfenv/bin/python3", ["--version"]);
    } catch (pyError) {
      throw new Error("Python is not available at /app/pdfenv/bin/python3");
    }
    
    throw new Error(`Failed to convert JSON to CSV: ${error.message}`);
  }
},

"convert-json-to-xml": async (inp, out) => {
  try {
    console.log(`Converting JSON to XML: ${inp} -> ${out}`);
    
    // Check if input file exists
    if (!fs.existsSync(inp)) {
      throw new Error("Input JSON file not found");
    }
    
    // Ensure output has .xml extension
    if (!out.toLowerCase().endsWith('.xml')) {
      out = out + '.xml';
    }
    
    const pythonPath = "/app/pdfenv/bin/python3";
    
    // Python script for JSON to XML conversion (fixed regex)
    const pythonScript = `
import json
import xml.etree.ElementTree as ET
from xml.dom import minidom
import sys
import re

def escape_xml_text(text):
    """Escape special XML characters"""
    if text is None:
        return ""
    text = str(text)
    text = text.replace('&', '&amp;')
    text = text.replace('<', '&lt;')
    text = text.replace('>', '&gt;')
    text = text.replace('"', '&quot;')
    text = text.replace("'", '&apos;')
    return text

def sanitize_xml_name(name):
    """Sanitize XML element names to be valid"""
    if not name or not isinstance(name, str):
        return "item"
    
    # ✅ FIXED regex (dash moved to end)
    name = re.sub(r'[^a-zA-Z0-9_.-]', '_', name)
    
    # Ensure it starts with a letter or underscore
    if not re.match(r'^[a-zA-Z_]', name):
        name = '_' + name
    
    # Ensure it's not a reserved XML word
    if name.lower() in ['xml', 'version', 'encoding']:
        name = '_' + name
    
    return name

def dict_to_xml(tag, d):
    """Convert dictionary to XML element"""
    elem = ET.Element(sanitize_xml_name(tag))
    
    for key, val in d.items():
        safe_key = sanitize_xml_name(key)
        
        if isinstance(val, dict):
            elem.append(dict_to_xml(safe_key, val))
        elif isinstance(val, list):
            for item in val:
                if isinstance(item, dict):
                    elem.append(dict_to_xml(safe_key, item))
                else:
                    child = ET.Element(safe_key)
                    child.text = escape_xml_text(item)
                    elem.append(child)
        else:
            child = ET.Element(safe_key)
            child.text = escape_xml_text(val)
            elem.append(child)
    
    return elem

def convert_json_to_xml(input_file, output_file):
    try:
        with open(input_file, 'r', encoding='utf-8') as f:
            content = f.read().strip()
            
        if not content:
            raise ValueError("JSON file is empty")
        
        try:
            data = json.loads(content)
        except json.JSONDecodeError as e:
            raise ValueError(f"Invalid JSON format: {e}")
        
        root_tag = "root"
        
        if isinstance(data, dict):
            root = dict_to_xml(root_tag, data)
        elif isinstance(data, list):
            root = ET.Element(root_tag)
            for i, item in enumerate(data):
                if isinstance(item, dict):
                    root.append(dict_to_xml(f"item_{i}", item))
                else:
                    child = ET.Element("item")
                    child.text = escape_xml_text(item)
                    root.append(child)
        else:
            root = ET.Element(root_tag)
            root.text = escape_xml_text(data)
        
        tree = ET.ElementTree(root)
        rough_string = ET.tostring(root, 'utf-8')
        reparsed = minidom.parseString(rough_string)
        pretty_xml = reparsed.toprettyxml(indent="  ", encoding='utf-8')
        
        pretty_xml_str = pretty_xml.decode('utf-8')
        lines = pretty_xml_str.split('\\n')
        
        cleaned_lines = []
        for line in lines:
            line = line.strip()
            if line and not line.startswith('<?xml') and not line.startswith('<!DOCTYPE'):
                cleaned_lines.append(line)
        
        final_xml = '<?xml version="1.0" encoding="UTF-8"?>\\n' + '\\n'.join(cleaned_lines)
        
        with open(output_file, 'w', encoding='utf-8') as f:
            f.write(final_xml)
        
        print("Successfully converted JSON to XML")
        return True
        
    except Exception as e:
        print(f"Conversion error: {str(e)}")
        import traceback
        traceback.print_exc()
        return False

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("ERROR: Usage: python script.py <input.json> <output.xml>")
        sys.exit(1)
    
    input_file = sys.argv[1]
    output_file = sys.argv[2]
    
    success = convert_json_to_xml(input_file, output_file)
    if success:
        print("SUCCESS: Conversion completed")
        sys.exit(0)
    else:
        print("ERROR: Conversion failed")
        sys.exit(1)
`;
    
    // Create temporary Python script
    const scriptPath = path.join(os.tmpdir(), `json_to_xml_${uuidv4()}.py`);
    await fsp.writeFile(scriptPath, pythonScript);
    
    console.log(`Running Python script: ${pythonPath} ${scriptPath} ${inp} ${out}`);
    
    // Execute Python script
    const { stdout, stderr } = await run(pythonPath, [scriptPath, inp, out]);
    
    console.log("Python stdout:", stdout);
    if (stderr) console.log("Python stderr:", stderr);
    
    // Clean up
    await fsp.unlink(scriptPath).catch(() => {});
    
    // Verify output file
    const stats = await fsp.stat(out);
    if (!stats || stats.size === 0) {
      throw new Error("XML conversion failed - output file is empty");
    }
    
    console.log(`XML created successfully: ${stats.size} bytes`);
    return out;
    
  } catch (error) {
    console.error("JSON to XML conversion failed:", error);
    
    try {
      await run("/app/pdfenv/bin/python3", ["--version"]);
    } catch (pyError) {
      throw new Error("Python is not available at /app/pdfenv/bin/python3");
    }
    
    throw new Error(`Failed to convert JSON to XML: ${error.message}`);
  }
},

"convert-xml-to-json": async (inp, out) => {
  try {
    console.log(`Converting XML to JSON: ${inp} -> ${out}`);
    
    if (!fs.existsSync(inp)) {
      throw new Error("Input XML file not found");
    }

    if (!out.toLowerCase().endsWith('.json')) {
      out = out + '.json';
    }

    const pythonPath = "/app/pdfenv/bin/python3";

    const pythonScript = `
import json
import xml.etree.ElementTree as ET
import sys

def xml_to_dict(elem):
    """Recursively convert XML to dict"""
    d = {}
    
    # Handle element attributes
    if elem.attrib:
        d["@attributes"] = elem.attrib

    # Handle element children
    children = list(elem)
    if children:
        child_dict = {}
        for child in children:
            child_name = child.tag
            child_obj = xml_to_dict(child)
            
            if child_name in child_dict:
                if not isinstance(child_dict[child_name], list):
                    child_dict[child_name] = [child_dict[child_name]]
                child_dict[child_name].append(child_obj)
            else:
                child_dict[child_name] = child_obj
        d.update(child_dict)
    else:
        # Leaf node: use text
        if elem.text and elem.text.strip():
            d["#text"] = elem.text.strip()
    
    return d

def convert_xml_to_json(input_file, output_file):
    try:
        tree = ET.parse(input_file)
        root = tree.getroot()
        
        data = {root.tag: xml_to_dict(root)}
        
        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        
        print("Successfully converted XML to JSON")
        return True
    except Exception as e:
        print(f"Conversion error: {str(e)}")
        import traceback
        traceback.print_exc()
        return False

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("ERROR: Usage: python script.py <input.xml> <output.json>")
        sys.exit(1)
    
    input_file = sys.argv[1]
    output_file = sys.argv[2]
    
    success = convert_xml_to_json(input_file, output_file)
    if success:
        print("SUCCESS: Conversion completed")
        sys.exit(0)
    else:
        print("ERROR: Conversion failed")
        sys.exit(1)
`;

    // Create temporary Python script
    const scriptPath = path.join(os.tmpdir(), `xml_to_json_${uuidv4()}.py`);
    await fsp.writeFile(scriptPath, pythonScript);

    console.log(`Running Python script: ${pythonPath} ${scriptPath} ${inp} ${out}`);

    const { stdout, stderr } = await run(pythonPath, [scriptPath, inp, out]);

    console.log("Python stdout:", stdout);
    if (stderr) console.log("Python stderr:", stderr);

    await fsp.unlink(scriptPath).catch(() => {});

    // Verify output JSON
    const stats = await fsp.stat(out);
    if (!stats || stats.size === 0) {
      throw new Error("JSON conversion failed - output file is empty");
    }

    console.log(`JSON created successfully: ${stats.size} bytes`);
    return out;

  } catch (error) {
    console.error("XML to JSON conversion failed:", error);

    try {
      await run("/app/pdfenv/bin/python3", ["--version"]);
    } catch (pyError) {
      throw new Error("Python is not available at /app/pdfenv/bin/python3");
    }

    throw new Error(`Failed to convert XML to JSON: ${error.message}`);
  }
},




// ---------------- Converter Function ----------------
"rotate-image": async (inputs, out, req) => {
  const sharp = require("sharp");
  const path = require("path");
  const fs = require("fs");
  const fsp = fs.promises;
  const os = require("os");
  const { v4: uuidv4 } = require("uuid");
  const archiver = require("archiver");

  const angle = parseFloat(req.body?.angle || "0");

  if (inputs.length === 1) {
    // Single file
    await sharp(inputs[0])
      .rotate(angle, { background: { r: 255, g: 255, b: 255, alpha: 0 } })
      .toFile(out);
  } else {
    // Multiple files
    const tmpDir = path.join(os.tmpdir(), `rotate_${uuidv4()}`);
    await fsp.mkdir(tmpDir, { recursive: true });

    const outputFiles = [];

    for (let i = 0; i < inputs.length; i++) {
      const originalPath = inputs[i];
      const originalName = req.files[i].originalname; // use original file name
      const ext = path.extname(originalName).toLowerCase();
      const baseName = path.basename(originalName, ext);

      const cleanBaseName = baseName.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-]/g, '');
      const fileOut = path.join(tmpDir, `${cleanBaseName}-rotated${ext}`);
      const zipEntryName = `${cleanBaseName}-rotated${ext}`;

      console.log(`Processing: ${originalPath} -> ${fileOut} (ZIP: ${zipEntryName})`);

      await sharp(originalPath)
        .rotate(angle, { background: { r: 255, g: 255, b: 255, alpha: 0 } })
        .toFile(fileOut);

      outputFiles.push({
        path: fileOut,
        name: zipEntryName,
        originalName: originalName
      });
    }

    // Create ZIP
    const output = fs.createWriteStream(out);
    const archive = archiver("zip", { zlib: { level: 9 }, store: true });

    await new Promise((resolve, reject) => {
      output.on("close", () => {
        console.log(`ZIP created successfully: ${archive.pointer()} bytes`);
        resolve();
      });
      output.on("error", (err) => reject(err));
      archive.on("error", (err) => reject(err));
      archive.pipe(output);

      outputFiles.forEach(fileInfo => {
        const stats = fs.statSync(fileInfo.path);
        if (stats.isFile() && stats.size > 0) {
          archive.file(fileInfo.path, { name: fileInfo.name, store: true });
          console.log(`Adding file to ZIP: ${fileInfo.path} as ${fileInfo.name}`);
        } else {
          console.warn(`Skipping empty or invalid file: ${fileInfo.path}`);
        }
      });

      archive.finalize();
    });

    // Clean up temporary files
    for (const fileInfo of outputFiles) {
      await fsp.unlink(fileInfo.path).catch(() => {});
    }
    await fsp.rmdir(tmpDir).catch(() => {});
  }
},


// Fix the watermark converter - replace your existing implementation
"add-watermark-pdf": async (inp, out, req) => {
  try {
    console.log("Request body:", req.body);
    
    const watermarkText = req.body?.watermarkText;
    const watermarkType = req.body?.watermarkType || "text";
    const opacity = req.body?.opacity || "0.3";
    const position = req.body?.position || "center";
    const fontSize = req.body?.fontSize || "60";
    
    console.log(`Adding ${watermarkType} watermark to PDF: ${inp}`);
    console.log(`Position: ${position}, Opacity: ${opacity}, Font size: ${fontSize}`);

    // Check if we have the required inputs
    if (watermarkType === "text" && !watermarkText) {
      throw new Error("Watermark text is required for text watermarks");
    }

    if (watermarkType === "image") {
      // Check if we have an image file in the request
      const imageFiles = req.files?.filter(f => f.mimetype.startsWith('image/'));
      if (!imageFiles || imageFiles.length === 0) {
        throw new Error("Image file is required for image watermarks");
      }
    }

    // Create temporary stamp file
    const stampFile = path.join(os.tmpdir(), `stamp-${uuidv4()}.pdf`);

    if (watermarkType === "text") {
      // Text watermark - calculate position
      console.log(`Creating text watermark: ${watermarkText} at position: ${position}`);
      
      // Set position coordinates based on selection
      let gravity, coordinates, rotate;
      
      switch(position) {
        case "top-left":
          gravity = "northwest";
          coordinates = "50,50";
          rotate = "0";
          break;
        case "top-right":
          gravity = "northeast";
          coordinates = "50,50";
          rotate = "0";
          break;
        case "bottom-left":
          gravity = "southwest";
          coordinates = "50,50";
          rotate = "0";
          break;
        case "bottom-right":
          gravity = "southeast";
          coordinates = "50,50";
          rotate = "0";
          break;
        case "top":
          gravity = "north";
          coordinates = "0,50";
          rotate = "0";
          break;
        case "bottom":
          gravity = "south";
          coordinates = "0,50";
          rotate = "0";
          break;
        case "diagonal":
          gravity = "center";
          coordinates = "0,0";
          rotate = "-45";
          break;
        case "center":
        default:
          gravity = "center";
          coordinates = "0,0";
          rotate = "0";
      }
      
      // Create text watermark with proper positioning
      await run("convert", [
        "-size", "600x800",
        "-background", "none",
        "-fill", `rgba(0,0,0,${opacity})`,
        "-font", "Helvetica",
        "-pointsize", fontSize,
        "-gravity", gravity,
        `caption:${watermarkText.replace(/'/g, "\\'").replace(/"/g, '\\"')}`,
        "-rotate", rotate,
        "pdf:" + stampFile
      ]);

    } else if (watermarkType === "image") {
      // Image watermark
      const imageFiles = req.files.filter(f => f.mimetype.startsWith('image/'));
      const imagePath = imageFiles[0].path;
      
      console.log(`Creating image watermark from: ${imagePath} at position: ${position}`);
      
      if (!fs.existsSync(imagePath)) {
        throw new Error("Watermark image file not found");
      }

      // Set position for image watermark
      let gravity;
      switch(position) {
        case "top-left":
          gravity = "northwest";
          break;
        case "top-right":
          gravity = "northeast";
          break;
        case "bottom-left":
          gravity = "southwest";
          break;
        case "bottom-right":
          gravity = "southeast";
          break;
        case "top":
          gravity = "north";
          break;
        case "bottom":
          gravity = "south";
          break;
        case "diagonal":
          // For diagonal, we'll use composite with offset
          gravity = "none";
          break;
        case "center":
        default:
          gravity = "center";
      }

      if (position === "diagonal") {
        // Special handling for diagonal image watermark
        await run("convert", [
          "-size", "600x800",
          "xc:none",
          "-fill", `rgba(255,255,255,${opacity})`,
          imagePath,
          "-geometry", "+200+200", // Position for diagonal
          "-composite",
          "pdf:" + stampFile
        ]);
      } else {
        // Regular positioned image watermark
        await run("convert", [
          "-size", "600x800",
          "xc:none",
          imagePath,
          "-gravity", gravity,
          "-geometry", "+20+20", // Small offset from edge
          "-composite",
          "pdf:" + stampFile
        ]);
      }
    }

    // Check if stamp file was created
    if (!fs.existsSync(stampFile)) {
      throw new Error("Failed to create watermark stamp");
    }

    console.log(`Stamp file created: ${stampFile}`);

    // Apply watermark to all pages using pdftk
    await run("pdftk", [
      inp,
      "multistamp", stampFile,
      "output", out
    ]);

    // Clean up stamp file
    await fsp.unlink(stampFile).catch(() => {});

    console.log(`Watermark added successfully: ${out}`);

  } catch (error) {
    console.error("Watermark failed:", error);
    throw new Error(`Failed to add watermark: ${error.message}`);
  }
},

};

// Validate converters against config
for (const converter of convertersConfig) {
  if (!converters[converter.slug]) {
    console.warn(`No implementation for converter: ${converter.slug}`);
  }
}

// Conversion API
app.post("/api/convert/:slug", upload.array("files"), async (req, res) => {
 
  const slug = req.params.slug;
  const handler = converters[slug];
  if (!handler) return res.status(400).json({ error: "Unsupported conversion" });
  if (!req.files?.length) return res.status(400).json({ error: "No files uploaded" });

  // Find converter config
  const converterConfig = convertersConfig.find(c => c.slug === slug);
  const targetExt = converterConfig?.outputs?.[0] || slug.split("-to-")[1] || "bin";
  const files = req.files.map(f => f.path);
const outFile = path.join("converted", `${Date.now()}-${slug}.pdf`);


  try {
    // Special multi-file handlers
         
 
// Add to your conversion API endpoint

// Special case: sign-pdf
// Node.js backend route handler
if (slug === "sign-pdf") {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "Please upload a PDF file" });
    }

    // Get form data
    const sigType = req.body.sigType || "draw";
    const signatureData = req.body.signatureData || "";
    const pageNumber = parseInt(req.body.pageNumber) || 1;
    const signaturePosition = req.body.signaturePosition || "bottom-right";
    const signatureFont = req.body.signatureFont || "arial";

    // Find PDF file
    const pdfFile = req.files.find(f => f.mimetype === "application/pdf");
    if (!pdfFile) {
      return res.status(400).json({ error: "Please upload a PDF file" });
    }

    // Handle different signature types
    let signatureImagePath = "";
    if (sigType === "upload") {
      const sigFile = req.files.find(f => f.mimetype.startsWith("image/"));
      if (!sigFile) {
        return res.status(400).json({ error: "Please upload a signature image" });
      }
      signatureImagePath = sigFile.path;
    }

    // Generate output path
    const baseName = path.basename(pdfFile.originalname, path.extname(pdfFile.originalname));
    const outFile = path.join("converted", `${baseName}_signed_${Date.now()}.pdf`);

    // Run the Python script
    const scriptPath = path.join(process.cwd(), "sign_pdf.py");
    const pythonPath = "/app/pdfenv/bin/python3";

    const args = [
      scriptPath,
      pdfFile.path,
      outFile,
      sigType,
      signatureData,
      req.body.typedSignature || "",
      signatureFont,
      signaturePosition,
      String(pageNumber)
    ];

    if (sigType === "upload" && signatureImagePath) {
      args.push(signatureImagePath);
    }

    await run(pythonPath, args);

    if (!fs.existsSync(outFile)) {
      throw new Error("Signature process failed: no output file created");
    }

    // Cleanup
    req.files.forEach(file => {
      try {
        fs.unlinkSync(file.path);
      } catch (e) {
        console.error("Error deleting temp file:", e);
      }
    });

    // Return result
    return res.download(outFile, `${baseName}_signed.pdf`, (err) => {
      if (err) {
        console.error("Download error:", err);
      }
      // Clean up the converted file after download
      try {
        fs.unlinkSync(outFile);
      } catch (e) {
        console.error("Error deleting output file:", e);
      }
    });

  } catch (err) {
    console.error("Sign PDF Error:", err);
    return res.status(500).json({ error: "Conversion failed", details: err.message });
  }
}

// Add to your conversion API endpoint
if (slug === "md-to-html") {
  console.log("Markdown to HTML request received");
  
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "Please upload at least one Markdown file" });
  }

  try {
    if (req.files.length === 1) {
      // SINGLE FILE
      const file = req.files[0];
      const inputPath = file.path;
      
      // Validate it's a Markdown file
      if (!file.originalname.toLowerCase().endsWith('.md')) {
        await fsp.unlink(inputPath).catch(() => {});
        return res.status(400).json({ error: "Uploaded file is not a Markdown file (.md)" });
      }

      const outputPath = path.join(os.tmpdir(), `${uuidv4()}.html`);
      
      console.log(`Converting Markdown to HTML: ${file.originalname}`);
      await converters[slug](inputPath, outputPath);

      // Check if output was created
      if (!fs.existsSync(outputPath)) {
        throw new Error("HTML file was not created");
      }

      const stats = fs.statSync(outputPath);
      console.log(`HTML created: ${outputPath} (${stats.size} bytes)`);

      // Generate download filename
      const originalName = file.originalname;
      const baseName = path.basename(originalName, path.extname(originalName));
      const downloadName = `${baseName}.html`;

      // Set headers and send file
      res.setHeader('Content-Type', 'text/html');
      res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
      res.setHeader('Content-Length', stats.size);
      
      const fileStream = fs.createReadStream(outputPath);
      fileStream.pipe(res);

      fileStream.on('close', async () => {
        await fsp.unlink(outputPath).catch(() => {});
        await fsp.unlink(inputPath).catch(() => {});
        console.log("Temporary files cleaned up");
      });

    } else {
      // MULTIPLE FILES - create ZIP
      const outputPath = path.join(os.tmpdir(), `${uuidv4()}.zip`);
      const processedFiles = [];

      for (const file of req.files) {
        const inputPath = file.path;
        
        // Validate it's a Markdown file
        if (!file.originalname.toLowerCase().endsWith('.md')) {
          console.warn(`Skipping non-Markdown file: ${file.originalname}`);
          continue;
        }

        const tempOutputPath = path.join(os.tmpdir(), `${uuidv4()}.html`);
        
        console.log(`Converting Markdown to HTML: ${file.originalname}`);
        await converters[slug](inputPath, tempOutputPath);

        if (fs.existsSync(tempOutputPath)) {
          const baseName = path.basename(file.originalname, path.extname(file.originalname));
          const outputName = `${baseName}.html`;
          
          processedFiles.push({
            path: tempOutputPath,
            name: outputName
          });
        }

        await fsp.unlink(inputPath).catch(() => {});
      }

      if (processedFiles.length === 0) {
        throw new Error("No valid Markdown files were converted");
      }

      // Create ZIP archive
      await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outputPath);
        const archive = archiver("zip", { zlib: { level: 9 } });
        
        output.on('close', resolve);
        output.on('error', reject);
        archive.on('error', reject);
        
        archive.pipe(output);
        
        processedFiles.forEach(fileInfo => {
          archive.file(fileInfo.path, { name: fileInfo.name });
        });
        
        archive.finalize();
      });

      const stats = fs.statSync(outputPath);
      console.log(`ZIP file created: ${stats.size} bytes`);

      // Set headers for ZIP download
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="converted-html.zip"');
      res.setHeader('Content-Length', stats.size);
      
      const fileStream = fs.createReadStream(outputPath);
      fileStream.pipe(res);

      fileStream.on('close', async () => {
        await fsp.unlink(outputPath).catch(() => {});
        for (const fileInfo of processedFiles) {
          await fsp.unlink(fileInfo.path).catch(() => {});
        }
        console.log("All temporary files cleaned up");
      });
    }

  } catch (e) {
    console.error("Markdown to HTML conversion failed:", e);
    
    // Clean up any remaining files
    for (const file of req.files) {
      await fsp.unlink(file.path).catch(() => {});
    }
    
    return res.status(500).json({ 
      error: "Failed to convert Markdown to HTML", 
      details: e.message 
    });
  }
}


if (slug === "svg-to-pdf") {
  console.log("SVG to PDF request received");
  
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "Please upload at least one SVG file" });
  }

  try {
    if (req.files.length === 1) {
      // SINGLE FILE
      const file = req.files[0];
      const inputPath = file.path;
      
      // Validate it's an SVG file
      if (!file.mimetype.includes('svg') && !file.originalname.toLowerCase().endsWith('.svg')) {
        return res.status(400).json({ error: "Uploaded file is not an SVG file" });
      }

      const outputPath = path.join(os.tmpdir(), `${uuidv4()}.pdf`);
      
      console.log(`Converting SVG to PDF: ${file.originalname}`);
      await converters[slug](inputPath, outputPath);

      // Check if output was created
      if (!fs.existsSync(outputPath)) {
        throw new Error("PDF file was not created");
      }

      const stats = fs.statSync(outputPath);
      console.log(`PDF created: ${outputPath} (${stats.size} bytes)`);

      // Generate download filename
      const originalName = file.originalname;
      const baseName = path.basename(originalName, path.extname(originalName));
      const downloadName = `${baseName}.pdf`;

      // Set headers and send file
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
      res.setHeader('Content-Length', stats.size);
      
      const fileStream = fs.createReadStream(outputPath);
      fileStream.pipe(res);

      fileStream.on('close', async () => {
        await fsp.unlink(outputPath).catch(() => {});
        await fsp.unlink(inputPath).catch(() => {});
        console.log("Temporary files cleaned up");
      });

    } else {
      // MULTIPLE FILES - create ZIP
      const outputPath = path.join(os.tmpdir(), `${uuidv4()}.zip`);
      const processedFiles = [];

      for (const file of req.files) {
        const inputPath = file.path;
        
        // Validate it's an SVG file
        if (!file.mimetype.includes('svg') && !file.originalname.toLowerCase().endsWith('.svg')) {
          console.warn(`Skipping non-SVG file: ${file.originalname}`);
          continue;
        }

        const tempOutputPath = path.join(os.tmpdir(), `${uuidv4()}.pdf`);
        
        console.log(`Converting SVG to PDF: ${file.originalname}`);
        await converters[slug](inputPath, tempOutputPath);

        if (fs.existsSync(tempOutputPath)) {
          const baseName = path.basename(file.originalname, path.extname(file.originalname));
          const outputName = `${baseName}.pdf`;
          
          processedFiles.push({
            path: tempOutputPath,
            name: outputName
          });
        }

        await fsp.unlink(inputPath).catch(() => {});
      }

      if (processedFiles.length === 0) {
        throw new Error("No valid SVG files were converted");
      }

      // Create ZIP archive
      await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outputPath);
        const archive = archiver("zip", { zlib: { level: 9 } });
        
        output.on('close', resolve);
        output.on('error', reject);
        archive.on('error', reject);
        
        archive.pipe(output);
        
        processedFiles.forEach(fileInfo => {
          archive.file(fileInfo.path, { name: fileInfo.name });
        });
        
        archive.finalize();
      });

      const stats = fs.statSync(outputPath);
      console.log(`ZIP file created: ${stats.size} bytes`);

      // Set headers for ZIP download
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="converted-pdfs.zip"');
      res.setHeader('Content-Length', stats.size);
      
      const fileStream = fs.createReadStream(outputPath);
      fileStream.pipe(res);

      fileStream.on('close', async () => {
        await fsp.unlink(outputPath).catch(() => {});
        for (const fileInfo of processedFiles) {
          await fsp.unlink(fileInfo.path).catch(() => {});
        }
        console.log("All temporary files cleaned up");
      });
    }

  } catch (e) {
    console.error("SVG to PDF conversion failed:", e);
    
    // Clean up any remaining files
    for (const file of req.files) {
      await fsp.unlink(file.path).catch(() => {});
    }
    
    return res.status(500).json({ 
      error: "Failed to convert SVG to PDF", 
      details: e.message 
    });
  }
}
if (slug === "pdf-to-excel") {
  console.log("PDF to Excel request received");
  
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "Please upload at least one PDF file" });
  }

  try {
    if (req.files.length === 1) {
      // SINGLE FILE
      const file = req.files[0];
      const inputPath = file.path;
      
      // Validate it's a PDF file
      if (!file.mimetype.includes('pdf') && !file.originalname.toLowerCase().endsWith('.pdf')) {
        return res.status(400).json({ error: "Uploaded file is not a PDF file" });
      }

      const outputPath = path.join(os.tmpdir(), `${uuidv4()}.xlsx`);
      
      console.log(`Converting PDF to Excel: ${file.originalname}`);
      await converters[slug](inputPath, outputPath);

      // Check if output was created
      if (!fs.existsSync(outputPath)) {
        throw new Error("Excel file was not created");
      }

      const stats = fs.statSync(outputPath);
      console.log(`Excel created: ${outputPath} (${stats.size} bytes)`);

      // Generate download filename
      const originalName = file.originalname;
      const baseName = path.basename(originalName, path.extname(originalName));
      const downloadName = `${baseName}.xlsx`;

      // Set headers and send file
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
      res.setHeader('Content-Length', stats.size);
      
      const fileStream = fs.createReadStream(outputPath);
      fileStream.pipe(res);

      fileStream.on('close', async () => {
        await fsp.unlink(outputPath).catch(() => {});
        await fsp.unlink(inputPath).catch(() => {});
        console.log("Temporary files cleaned up");
      });

    } else {
      // MULTIPLE FILES - create ZIP
      const outputPath = path.join(os.tmpdir(), `${uuidv4()}.zip`);
      const processedFiles = [];

      for (const file of req.files) {
        const inputPath = file.path;
        
        // Validate it's a PDF file
        if (!file.mimetype.includes('pdf') && !file.originalname.toLowerCase().endsWith('.pdf')) {
          console.warn(`Skipping non-PDF file: ${file.originalname}`);
          continue;
        }

        const tempOutputPath = path.join(os.tmpdir(), `${uuidv4()}.xlsx`);
        
        console.log(`Converting PDF to Excel: ${file.originalname}`);
        await converters[slug](inputPath, tempOutputPath);

        if (fs.existsSync(tempOutputPath)) {
          const baseName = path.basename(file.originalname, path.extname(file.originalname));
          const outputName = `${baseName}.xlsx`;
          
          processedFiles.push({
            path: tempOutputPath,
            name: outputName
          });
        }

        await fsp.unlink(inputPath).catch(() => {});
      }

      if (processedFiles.length === 0) {
        throw new Error("No valid PDF files were converted");
      }

      // Create ZIP archive
      await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outputPath);
        const archive = archiver("zip", { zlib: { level: 9 } });
        
        output.on('close', resolve);
        output.on('error', reject);
        archive.on('error', reject);
        
        archive.pipe(output);
        
        processedFiles.forEach(fileInfo => {
          archive.file(fileInfo.path, { name: fileInfo.name });
        });
        
        archive.finalize();
      });

      const stats = fs.statSync(outputPath);
      console.log(`ZIP file created: ${stats.size} bytes`);

      // Set headers for ZIP download
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="converted-excels.zip"');
      res.setHeader('Content-Length', stats.size);
      
      const fileStream = fs.createReadStream(outputPath);
      fileStream.pipe(res);

      fileStream.on('close', async () => {
        await fsp.unlink(outputPath).catch(() => {});
        for (const fileInfo of processedFiles) {
          await fsp.unlink(fileInfo.path).catch(() => {});
        }
        console.log("All temporary files cleaned up");
      });
    }

  } catch (e) {
    console.error("PDF to Excel conversion failed:", e);
    
    // Clean up any remaining files
    for (const file of req.files) {
      await fsp.unlink(file.path).catch(() => {});
    }
    
    return res.status(500).json({ 
      error: "Failed to convert PDF to Excel", 
      details: e.message 
    });
  }
}
if (slug === "pdf-to-ocr-searchable") {
  console.log("PDF to Searchable PDF request received");
  
  if (!req.files || req.files.length !== 1) {
    return res.status(400).json({ error: "Please upload exactly one PDF file" });
  }

  let inputPdf;
  let output;

  try {
    inputPdf = req.files[0];
    
    // Validate it's a PDF
    if (!inputPdf.mimetype.includes('pdf')) {
      return res.status(400).json({ error: "Uploaded file is not a PDF" });
    }

    output = path.join(os.tmpdir(), `${uuidv4()}.pdf`);
    
    console.log(`Processing OCR for: ${inputPdf.originalname}`);
    
    // Pass the req object to the converter
    await converters[slug](inputPdf.path, output, req);

    // Check if output was created
    if (!fs.existsSync(output)) {
      throw new Error("Searchable PDF was not created");
    }

    const stats = fs.statSync(output);
    console.log(`Searchable PDF created: ${stats.size} bytes`);

    // Read the file and send it directly
    const pdfData = await fsp.readFile(output);
    const originalName = inputPdf.originalname;
    const baseName = path.basename(originalName, path.extname(originalName));
    const downloadName = `${baseName}-searchable.pdf`;

    // Set headers and send file
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
    res.setHeader('Content-Length', pdfData.length);
    res.send(pdfData);

    // Clean up
    await fsp.unlink(output);
    await fsp.unlink(inputPdf.path);
    
    console.log("Temporary files cleaned up");

  } catch (e) {
    console.error("PDF to searchable conversion failed:", e);
    
    // Clean up on error
    try {
      if (inputPdf) await fsp.unlink(inputPdf.path).catch(() => {});
      if (output && fs.existsSync(output)) await fsp.unlink(output).catch(() => {});
    } catch (cleanupError) {
      console.error('Cleanup error:', cleanupError);
    }
    
    return res.status(500).json({ 
      error: "Failed to create searchable PDF", 
      details: e.message 
    });
  }
}


// ---------------- API Route Handler ----------------

  // Special case: ocr-image-to-excel
    // Special case: ocr-image-to-excel
  if (slug === "ocr-image-to-excel") {
    console.log("OCR Image to Excel request received");
    
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "Please upload at least one image file" });
    }

    try {
      if (req.files.length === 1) {
        // SINGLE FILE
        const file = req.files[0];
        const inputPath = file.path;
        
        // Log file information for debugging
        console.log(`File upload details:`, {
          originalname: file.originalname,
          mimetype: file.mimetype,
          size: file.size,
          path: file.path
        });

        const outputPath = path.join(os.tmpdir(), `${uuidv4()}.xlsx`);
        
        console.log(`Converting Image to Excel via OCR: ${file.originalname}`);
        // PASS THE REQ OBJECT TO THE CONVERTER
        await converters[slug](inputPath, outputPath, req);

        // Check if output was created
        if (!fs.existsSync(outputPath)) {
          throw new Error("Excel file was not created");
        }

        const stats = fs.statSync(outputPath);
        console.log(`Excel file created: ${outputPath} (${stats.size} bytes)`);

        // Generate download filename
        const originalName = file.originalname;
        const baseName = path.basename(originalName, path.extname(originalName));
        const downloadName = `${baseName}.xlsx`;

        // Set headers and send file
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
        res.setHeader('Content-Length', stats.size);
        
        const fileStream = fs.createReadStream(outputPath);
        fileStream.pipe(res);

        fileStream.on('close', async () => {
          await fsp.unlink(outputPath).catch(() => {});
          await fsp.unlink(inputPath).catch(() => {});
          console.log("Temporary files cleaned up");
        });

      } else {
        // MULTIPLE FILES - create ZIP (batch processing)
        const outputPath = path.join(os.tmpdir(), `${uuidv4()}.zip`);
        const processedFiles = [];

        for (const file of req.files) {
          const inputPath = file.path;
          
          // Log file information for debugging
          console.log(`File upload details:`, {
            originalname: file.originalname,
            mimetype: file.mimetype,
            size: file.size,
            path: file.path
          });

          const tempOutputPath = path.join(os.tmpdir(), `${uuidv4()}.xlsx`);
          
          console.log(`Converting Image to Excel via OCR: ${file.originalname}`);
          // PASS THE REQ OBJECT TO THE CONVERTER
          await converters[slug](inputPath, tempOutputPath, req);

          if (fs.existsSync(tempOutputPath)) {
            const baseName = path.basename(file.originalname, path.extname(file.originalname));
            const outputName = `${baseName}.xlsx`;
            
            processedFiles.push({
              path: tempOutputPath,
              name: outputName
            });
          }

          await fsp.unlink(inputPath).catch(() => {});
        }

        if (processedFiles.length === 0) {
          throw new Error("No valid image files were converted");
        }

        // Create ZIP archive
        await new Promise((resolve, reject) => {
          const output = fs.createWriteStream(outputPath);
          const archive = archiver("zip", { zlib: { level: 9 } });
          
          output.on('close', resolve);
          output.on('error', reject);
          archive.on('error', reject);
          
          archive.pipe(output);
          
          processedFiles.forEach(fileInfo => {
            archive.file(fileInfo.path, { name: fileInfo.name });
          });
          
          archive.finalize();
        });

        const stats = fs.statSync(outputPath);
        console.log(`ZIP file created: ${stats.size} bytes`);

        // Set headers for ZIP download
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', 'attachment; filename="extracted-tables.zip"');
        res.setHeader('Content-Length', stats.size);
        
        const fileStream = fs.createReadStream(outputPath);
        fileStream.pipe(res);

        fileStream.on('close', async () => {
          await fsp.unlink(outputPath).catch(() => {});
          for (const fileInfo of processedFiles) {
            await fsp.unlink(fileInfo.path).catch(() => {});
          }
          console.log("All temporary files cleaned up");
        });
      }

    } catch (e) {
      console.error("OCR Image to Excel conversion failed:", e);
      
      // Clean up any remaining files
      for (const file of req.files) {
        await fsp.unlink(file.path).catch(() => {});
      }
      
      return res.status(500).json({ 
        error: "Failed to extract table data from image", 
        details: e.message 
      });
    }
  }

// Add to your conversion API endpoint
if (slug === "image-to-svg") {
  console.log("Image to SVG request received");
  
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "Please upload at least one image file" });
  }

  try {
    if (req.files.length === 1) {
      // SINGLE FILE
      const file = req.files[0];
      const inputPath = file.path;
      
      // Validate it's an image
      if (!file.mimetype.startsWith('image/')) {
        return res.status(400).json({ error: "Uploaded file is not an image" });
      }

      const outputPath = path.join(os.tmpdir(), `${uuidv4()}.svg`);
      
      console.log(`Converting image to SVG: ${file.originalname}`);
      await converters[slug](inputPath, outputPath);

      // Check if output was created
      if (!fs.existsSync(outputPath)) {
        throw new Error("SVG file was not created");
      }

      const stats = fs.statSync(outputPath);
      console.log(`SVG created: ${outputPath} (${stats.size} bytes)`);

      // Generate download filename
      const originalName = file.originalname;
      const baseName = path.basename(originalName, path.extname(originalName));
      const downloadName = `${baseName}.svg`;

      // Set headers and send file
      res.setHeader('Content-Type', 'image/svg+xml');
      res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
      res.setHeader('Content-Length', stats.size);
      
      const fileStream = fs.createReadStream(outputPath);
      fileStream.pipe(res);

      fileStream.on('close', async () => {
        await fsp.unlink(outputPath).catch(() => {});
        await fsp.unlink(inputPath).catch(() => {});
        console.log("Temporary files cleaned up");
      });

    } else {
      // MULTIPLE FILES - create ZIP
      const outputPath = path.join(os.tmpdir(), `${uuidv4()}.zip`);
      const processedFiles = [];

      for (const file of req.files) {
        const inputPath = file.path;
        
        if (!file.mimetype.startsWith('image/')) {
          console.warn(`Skipping non-image file: ${file.originalname}`);
          continue;
        }

        const tempOutputPath = path.join(os.tmpdir(), `${uuidv4()}.svg`);
        
        console.log(`Converting image to SVG: ${file.originalname}`);
        await converters[slug](inputPath, tempOutputPath);

        if (fs.existsSync(tempOutputPath)) {
          const baseName = path.basename(file.originalname, path.extname(file.originalname));
          const outputName = `${baseName}.svg`;
          
          processedFiles.push({
            path: tempOutputPath,
            name: outputName
          });
        }

        await fsp.unlink(inputPath).catch(() => {});
      }

      if (processedFiles.length === 0) {
        throw new Error("No valid image files were converted");
      }

      // Create ZIP archive
      await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outputPath);
        const archive = archiver("zip", { zlib: { level: 9 } });
        
        output.on('close', resolve);
        output.on('error', reject);
        archive.on('error', reject);
        
        archive.pipe(output);
        
        processedFiles.forEach(fileInfo => {
          archive.file(fileInfo.path, { name: fileInfo.name });
        });
        
        archive.finalize();
      });

      const stats = fs.statSync(outputPath);
      console.log(`ZIP file created: ${stats.size} bytes`);

      // Set headers for ZIP download
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="converted-svgs.zip"');
      res.setHeader('Content-Length', stats.size);
      
      const fileStream = fs.createReadStream(outputPath);
      fileStream.pipe(res);

      fileStream.on('close', async () => {
        await fsp.unlink(outputPath).catch(() => {});
        for (const fileInfo of processedFiles) {
          await fsp.unlink(fileInfo.path).catch(() => {});
        }
        console.log("All temporary files cleaned up");
      });
    }

  } catch (e) {
    console.error("Image to SVG conversion failed:", e);
    
    // Clean up any remaining files
    for (const file of req.files) {
      await fsp.unlink(file.path).catch(() => {});
    }
    
    return res.status(500).json({ 
      error: "Failed to convert images to SVG", 
      details: e.message 
    });
  }
}

// Add to your conversion API endpoint
if (slug === "merge-images-to-pdf") {
  console.log("Merge Images to PDF request received");
  
  if (!req.files || req.files.length < 1) {
    return res.status(400).json({ error: "Please upload at least one image file" });
  }

  try {
    const inputs = req.files.map(f => f.path);
    const output = path.join(os.tmpdir(), `${uuidv4()}.pdf`);
    
    console.log(`Merging ${inputs.length} images to PDF`);
    await converters[slug](inputs, output);

    // Check if output was created
    if (!fs.existsSync(output)) {
      throw new Error("PDF file was not created");
    }

    const stats = fs.statSync(output);
    console.log(`PDF created: ${output} (${stats.size} bytes)`);

    // Generate download filename
    const downloadName = "merged-images.pdf";
    
    // Set headers and send file
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
    res.setHeader('Content-Length', stats.size);
    
    const fileStream = fs.createReadStream(output);
    fileStream.pipe(res);
    
    // Clean up after streaming is done
    fileStream.on('close', async () => {
      try {
        await fsp.unlink(output).catch(() => {});
        for (const input of inputs) {
          await fsp.unlink(input).catch(() => {});
        }
        console.log("Temporary files cleaned up");
      } catch (cleanupError) {
        console.error('Cleanup error:', cleanupError);
      }
    });
    
  } catch (e) {
    console.error("Image merge failed:", e);
    
    // Clean up on error
    for (const file of req.files) {
      await fsp.unlink(file.path).catch(() => {});
    }
    
    return res.status(500).json({ 
      error: "Failed to merge images to PDF", 
      details: e.message 
    });
  }
}

// Add to your conversion API endpoint
if (slug === "remove-metadata-image") {
  console.log("Remove Metadata request received");
  
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "Please upload at least one image file" });
  }

  try {
    if (req.files.length === 1) {
      // SINGLE FILE
      const file = req.files[0];
      const inputPath = file.path;
      
      // Validate it's an image
      if (!file.mimetype.startsWith('image/')) {
        return res.status(400).json({ error: "Uploaded file is not an image" });
      }

      const originalExt = path.extname(file.originalname);
      const outputPath = path.join(os.tmpdir(), `${uuidv4()}${originalExt}`);
      
      console.log(`Processing metadata removal for: ${file.originalname}`);
      await converters[slug](inputPath, outputPath);

      // Check if output was created
      if (!fs.existsSync(outputPath)) {
        throw new Error("Processed image was not created");
      }

      const stats = fs.statSync(outputPath);
      console.log(`Metadata-free image created: ${stats.size} bytes`);

      // Generate download filename
      const originalName = file.originalname;
      const baseName = path.basename(originalName, path.extname(originalName));
      const downloadName = `${baseName}-cleaned${originalExt}`;

      // Determine content type
      let contentType = 'image/jpeg';
      if (originalExt.toLowerCase() === '.png') contentType = 'image/png';
      else if (originalExt.toLowerCase() === '.gif') contentType = 'image/gif';
      else if (originalExt.toLowerCase() === '.bmp') contentType = 'image/bmp';
      else if (originalExt.toLowerCase() === '.webp') contentType = 'image/webp';
      else if (originalExt.toLowerCase() === '.heic') contentType = 'image/heic';

      // Set headers and send file
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
      res.setHeader('Content-Length', stats.size);
      
      const fileStream = fs.createReadStream(outputPath);
      fileStream.pipe(res);

      fileStream.on('close', async () => {
        await fsp.unlink(outputPath).catch(() => {});
        await fsp.unlink(inputPath).catch(() => {});
        console.log("Temporary files cleaned up");
      });

    } else {
      // MULTIPLE FILES - create ZIP
      const outputPath = path.join(os.tmpdir(), `${uuidv4()}.zip`);
      const processedFiles = [];

      for (const file of req.files) {
        const inputPath = file.path;
        
        if (!file.mimetype.startsWith('image/')) {
          console.warn(`Skipping non-image file: ${file.originalname}`);
          continue;
        }

        const originalExt = path.extname(file.originalname);
        const tempOutputPath = path.join(os.tmpdir(), `${uuidv4()}${originalExt}`);
        
        console.log(`Processing metadata removal for: ${file.originalname}`);
        await converters[slug](inputPath, tempOutputPath);

        if (fs.existsSync(tempOutputPath)) {
          const baseName = path.basename(file.originalname, path.extname(file.originalname));
          const outputName = `${baseName}-cleaned${originalExt}`;
          
          processedFiles.push({
            path: tempOutputPath,
            name: outputName
          });
        }

        await fsp.unlink(inputPath).catch(() => {});
      }

      if (processedFiles.length === 0) {
        throw new Error("No valid image files were processed");
      }

      // Create ZIP archive
      await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outputPath);
        const archive = archiver("zip", { zlib: { level: 9 } });
        
        output.on('close', resolve);
        output.on('error', reject);
        archive.on('error', reject);
        
        archive.pipe(output);
        
        processedFiles.forEach(fileInfo => {
          archive.file(fileInfo.path, { name: fileInfo.name });
        });
        
        archive.finalize();
      });

      const stats = fs.statSync(outputPath);
      console.log(`ZIP file created: ${stats.size} bytes`);

      // Set headers for ZIP download
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="cleaned-images.zip"');
      res.setHeader('Content-Length', stats.size);
      
      const fileStream = fs.createReadStream(outputPath);
      fileStream.pipe(res);

      fileStream.on('close', async () => {
        await fsp.unlink(outputPath).catch(() => {});
        for (const fileInfo of processedFiles) {
          await fsp.unlink(fileInfo.path).catch(() => {});
        }
        console.log("All temporary files cleaned up");
      });
    }

  } catch (e) {
    console.error("Metadata removal failed:", e);
    
    // Clean up any remaining files
    for (const file of req.files) {
      await fsp.unlink(file.path).catch(() => {});
    }
    
    return res.status(500).json({ 
      error: "Failed to remove metadata from images", 
      details: e.message 
    });
  }
}
if (slug === "pdf-to-text") {
  console.log("PDF to Text request received");
  
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "Please upload at least one PDF file" });
  }

  try {
    if (req.files.length === 1) {
      // SINGLE FILE
      const file = req.files[0];
      const inputPath = file.path;
      
      // Validate it's a PDF file
      if (!file.mimetype.includes('pdf') && !file.originalname.toLowerCase().endsWith('.pdf')) {
        return res.status(400).json({ error: "Uploaded file is not a PDF file" });
      }

      const outputPath = path.join(os.tmpdir(), `${uuidv4()}.txt`);
      
      console.log(`Converting PDF to Text: ${file.originalname}`);
      await converters[slug](inputPath, outputPath);

      // Check if output was created
      if (!fs.existsSync(outputPath)) {
        throw new Error("Text file was not created");
      }

      const stats = fs.statSync(outputPath);
      console.log(`Text file created: ${outputPath} (${stats.size} bytes)`);

      // Generate download filename
      const originalName = file.originalname;
      const baseName = path.basename(originalName, path.extname(originalName));
      const downloadName = `${baseName}.txt`;

      // Set headers and send file
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
      res.setHeader('Content-Length', stats.size);
      
      const fileStream = fs.createReadStream(outputPath);
      fileStream.pipe(res);

      fileStream.on('close', async () => {
        await fsp.unlink(outputPath).catch(() => {});
        await fsp.unlink(inputPath).catch(() => {});
        console.log("Temporary files cleaned up");
      });

    } else {
      // MULTIPLE FILES - create ZIP (batch processing)
      const outputPath = path.join(os.tmpdir(), `${uuidv4()}.zip`);
      const processedFiles = [];

      for (const file of req.files) {
        const inputPath = file.path;
        
        // Validate it's a PDF file
        if (!file.mimetype.includes('pdf') && !file.originalname.toLowerCase().endsWith('.pdf')) {
          console.warn(`Skipping non-PDF file: ${file.originalname}`);
          continue;
        }

        const tempOutputPath = path.join(os.tmpdir(), `${uuidv4()}.txt`);
        
        console.log(`Converting PDF to Text: ${file.originalname}`);
        await converters[slug](inputPath, tempOutputPath);

        if (fs.existsSync(tempOutputPath)) {
          const baseName = path.basename(file.originalname, path.extname(file.originalname));
          const outputName = `${baseName}.txt`;
          
          processedFiles.push({
            path: tempOutputPath,
            name: outputName
          });
        }

        await fsp.unlink(inputPath).catch(() => {});
      }

      if (processedFiles.length === 0) {
        throw new Error("No valid PDF files were converted");
      }

      // Create ZIP archive
      await new Promise((resolve, reject) => {
        const output = fs.createWriteStream(outputPath);
        const archive = archiver("zip", { zlib: { level: 9 } });
        
        output.on('close', resolve);
        output.on('error', reject);
        archive.on('error', reject);
        
        archive.pipe(output);
        
        processedFiles.forEach(fileInfo => {
          archive.file(fileInfo.path, { name: fileInfo.name });
        });
        
        archive.finalize();
      });

      const stats = fs.statSync(outputPath);
      console.log(`ZIP file created: ${stats.size} bytes`);

      // Set headers for ZIP download
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', 'attachment; filename="extracted-texts.zip"');
      res.setHeader('Content-Length', stats.size);
      
      const fileStream = fs.createReadStream(outputPath);
      fileStream.pipe(res);

      fileStream.on('close', async () => {
        await fsp.unlink(outputPath).catch(() => {});
        for (const fileInfo of processedFiles) {
          await fsp.unlink(fileInfo.path).catch(() => {});
        }
        console.log("All temporary files cleaned up");
      });
    }

  } catch (e) {
    console.error("PDF to Text conversion failed:", e);
    
    // Clean up any remaining files
    for (const file of req.files) {
      await fsp.unlink(file.path).catch(() => {});
    }
    
    return res.status(500).json({ 
      error: "Failed to extract text from PDF", 
      details: e.message 
    });
  }
}

if (slug === "rotate-image") {
  console.log("Rotate Image request received");

  if (!req.files || req.files.length < 1) {
    return res.status(400).json({ error: "Please upload at least one image file" });
  }

  const inputs = req.files.map(f => f.path);
  const angle = parseFloat(req.body.angle) || 0;

  try {
    if (req.files.length === 1) {
      // SINGLE FILE
      const file = req.files[0];
      const originalName = file.originalname;
      const ext = path.extname(originalName);
      const baseName = path.basename(originalName, ext);
      const cleanBaseName = baseName.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-]/g, '');
      const outputName = `${cleanBaseName}-rotated${ext}`;
      const outputPath = path.join(os.tmpdir(), `${uuidv4()}${ext}`);

      await converters[slug](inputs, outputPath, req);

      // Headers
      const userAgent = req.headers['user-agent'] || '';
      let contentDisposition;
      if (userAgent.includes('Firefox')) {
        contentDisposition = `attachment; filename="${outputName}"`;
      } else if (userAgent.includes('Safari') && !userAgent.includes('Chrome')) {
        const encodedFilename = encodeURIComponent(outputName);
        contentDisposition = `attachment; filename="${encodedFilename}"`;
      } else {
        const encodedFilename = encodeURIComponent(outputName);
        contentDisposition = `attachment; filename="${outputName}"; filename*=UTF-8''${encodedFilename}`;
      }

      res.setHeader('Content-Disposition', contentDisposition);
      res.setHeader('Content-Type', getMimeType(ext));
      res.setHeader('X-Content-Type-Options', 'nosniff');

      const fileStream = fs.createReadStream(outputPath);
      fileStream.pipe(res);

      fileStream.on('close', async () => {
        await fsp.unlink(outputPath).catch(() => {});
        for (const f of inputs) await fsp.unlink(f).catch(() => {});
      });

    } else {
      // MULTIPLE FILES
      const outputPath = path.join(os.tmpdir(), `${uuidv4()}.zip`);

      console.log("Starting multiple file processing...");
      await converters[slug](inputs, outputPath, req);

      if (!fs.existsSync(outputPath)) throw new Error("ZIP file was not created");

      const stats = fs.statSync(outputPath);
      console.log(`ZIP file created: ${stats.size} bytes`);

      // ZIP filename based on first uploaded file
      const firstFile = req.files[0];
      const originalName = firstFile.originalname;
      const baseName = path.basename(originalName, path.extname(originalName));
      const cleanBaseName = baseName.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9-]/g, '');
      const zipFilename = `${cleanBaseName}-rotated-images.zip`;

      const userAgent = req.headers['user-agent'] || '';
      let contentDisposition;
      if (userAgent.includes('Firefox')) {
        contentDisposition = `attachment; filename="${zipFilename}"`;
      } else if (userAgent.includes('Safari') && !userAgent.includes('Chrome')) {
        const encodedFilename = encodeURIComponent(zipFilename);
        contentDisposition = `attachment; filename="${encodedFilename}"`;
      } else {
        const encodedFilename = encodeURIComponent(zipFilename);
        contentDisposition = `attachment; filename="${zipFilename}"; filename*=UTF-8''${encodedFilename}`;
      }

      res.setHeader('Content-Disposition', contentDisposition);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Length', stats.size);
      res.setHeader('X-Content-Type-Options', 'nosniff');

      const zipData = await fsp.readFile(outputPath);
      res.send(zipData);

      // Clean up
      await fsp.unlink(outputPath).catch(() => {});
      for (const f of inputs) await fsp.unlink(f).catch(() => {});

      console.log("ZIP download completed successfully");
    }
  } catch (e) {
    console.error("Rotate Image failed:", e);
    for (const f of inputs) await fsp.unlink(f).catch(() => {});
    return res.status(500).json({ error: "Rotate Image failed", details: e.message, code: e.code });
  }

  return;
}

if (slug === "add-page-numbers") {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "Please upload a PDF file" });
    }

    // Get PDF file
    const pdfFile = req.files.find(f => f.mimetype === "application/pdf");
    if (!pdfFile) {
      return res.status(400).json({ error: "Please upload a PDF file" });
    }

    // Get form data
    const position = req.body.position || "bottom-center";
    const startNum = parseInt(req.body.startNum) || 1;
    const format = req.body.format || "number";
    const fontSize = parseInt(req.body.fontSize) || 12;

    // Generate output path
    const baseName = path.basename(pdfFile.originalname, path.extname(pdfFile.originalname));
    const outFile = path.join("converted", `${baseName}_numbered_${Date.now()}.pdf`);

    // Run the Python script
    const scriptPath = path.join(process.cwd(), "pdf_numbering.py");
    const pythonPath = "/app/pdfenv/bin/python3";

    const args = [
      scriptPath,
      pdfFile.path,
      outFile,
      position,
      String(startNum),
      format,
      String(fontSize)
    ];

    await run(pythonPath, args);

    if (!fs.existsSync(outFile)) {
      throw new Error("Page numbering process failed: no output file created");
    }

    // Cleanup
    try {
      fs.unlinkSync(pdfFile.path);
    } catch (e) {
      console.error("Error deleting temp file:", e);
    }

    // Return the PDF file with proper headers
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${baseName}_numbered.pdf"`);
    
    const fileStream = fs.createReadStream(outFile);
    fileStream.pipe(res);
    
    // Clean up after sending
    fileStream.on('close', () => {
      try {
        fs.unlinkSync(outFile);
      } catch (e) {
        console.error("Error deleting output file:", e);
      }
    });

  } catch (err) {
    console.error("Add Page Numbers Error:", err);
    
    // Clean up any temporary files
    if (req.files) {
      req.files.forEach(file => {
        try {
          fs.unlinkSync(file.path);
        } catch (e) {
          console.error("Error cleaning up file:", e);
        }
      });
    }
    
    return res.status(500).json({ error: "Conversion failed", details: err.message });
  }
}

if (slug === "add-watermark-image") {
  console.log("Watermark Image request received");
  
  if (!req.files || req.files.length !== 1) {
    return res.status(400).json({ error: "Please upload exactly one image file" });
  }

  let inputImage;
  let output;

  try {
    inputImage = req.files[0];
    
    // Validate it's an image
    if (!inputImage.mimetype.startsWith('image/')) {
      return res.status(400).json({ error: "Uploaded file is not an image" });
    }

    // Keep original format or convert to specified format
    const originalExt = path.extname(inputImage.originalname);
    output = path.join(os.tmpdir(), `${uuidv4()}${originalExt}`);
    
    console.log(`Processing watermark for: ${inputImage.originalname}`);
    await converters[slug](inputImage.path, output, req);

    // Check if output was created
    if (!fs.existsSync(output)) {
      throw new Error("Watermarked image was not created");
    }

    const stats = fs.statSync(output);
    console.log(`Watermarked image created: ${stats.size} bytes`);

    // Read the file and send it directly
    const imageData = await fsp.readFile(output);
    const originalName = inputImage.originalname;
    const baseName = path.basename(originalName, path.extname(originalName));
    const downloadName = `${baseName}-watermarked${originalExt}`;

    // Set headers based on image type
    let contentType = 'image/jpeg';
    if (originalExt.toLowerCase() === '.png') contentType = 'image/png';
    else if (originalExt.toLowerCase() === '.gif') contentType = 'image/gif';
    else if (originalExt.toLowerCase() === '.bmp') contentType = 'image/bmp';
    else if (originalExt.toLowerCase() === '.webp') contentType = 'image/webp';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
    res.setHeader('Content-Length', imageData.length);
    res.send(imageData);

    // Clean up
    await fsp.unlink(output);
    await fsp.unlink(inputImage.path);
    console.log("Temporary files cleaned up");

  } catch (e) {
    console.error("Image watermark failed:", e);
    
    try {
      if (inputImage) await fsp.unlink(inputImage.path).catch(() => {});
      if (output && fs.existsSync(output)) await fsp.unlink(output).catch(() => {});
    } catch (cleanupError) {
      console.error('Cleanup error:', cleanupError);
    }
    
    return res.status(500).json({ 
      error: "Failed to add watermark to image", 
      details: e.message 
    });
  }
}


// Add to your conversion API endpoint
if (slug === "add-watermark-pdf") {
  console.log("Watermark PDF request received");
  
  if (!req.files || req.files.length < 1) {
    return res.status(400).json({ error: "Please upload at least one file" });
  }

  let inputPdf;
  let output;

  try {
    // Find the PDF file
    inputPdf = req.files.find(f => f.mimetype.includes('pdf'));
    if (!inputPdf) {
      return res.status(400).json({ error: "No PDF file found in upload" });
    }

    output = path.join(os.tmpdir(), `${uuidv4()}.pdf`);
    
    console.log(`Processing watermark for: ${inputPdf.originalname}`);
    await converters[slug](inputPdf.path, output, req);

    // Check if output was created
    if (!fs.existsSync(output)) {
      throw new Error("Watermarked PDF was not created");
    }

    const stats = fs.statSync(output);
    console.log(`Watermarked PDF created: ${stats.size} bytes`);

    // Read the file and send it directly
    const pdfData = await fsp.readFile(output);
    const originalName = inputPdf.originalname;
    const baseName = path.basename(originalName, path.extname(originalName));
    const downloadName = `${baseName}-watermarked.pdf`;

    // Set headers and send file
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
    res.setHeader('Content-Length', pdfData.length);
    res.send(pdfData);

    // Clean up
    await fsp.unlink(output);
    await fsp.unlink(inputPdf.path);
    
    // Clean up image files if any
    const imageFiles = req.files.filter(f => f.mimetype.startsWith('image/'));
    for (const imageFile of imageFiles) {
      await fsp.unlink(imageFile.path).catch(() => {});
    }
    
    console.log("Temporary files cleaned up");

  } catch (e) {
    console.error("Watermark failed:", e);
    
    // Clean up on error
    try {
      for (const file of req.files) {
        await fsp.unlink(file.path).catch(() => {});
      }
      if (output && fs.existsSync(output)) await fsp.unlink(output).catch(() => {});
    } catch (cleanupError) {
      console.error('Cleanup error:', cleanupError);
    }
    
    return res.status(500).json({ 
      error: "Failed to add watermark", 
      details: e.message 
    });
  }
}
    

         
    if (slug === "add-pdf-password" || slug === "remove-pdf-password") {
      if (req.files.length !== 1) {
        return res.status(400).json({ error: "Please upload exactly one PDF file" });
      }
    
      try {
        const input = req.files[0].path;
        const output = path.join(os.tmpdir(), `${slug}-${Date.now()}.pdf`);
        await converters[slug](input, output, req);
    
        res.download(output, `${slug}.pdf`, async () => {
          await fsp.unlink(output).catch(() => {});
          await fsp.unlink(input).catch(() => {});
        });
        return;
      } catch (e) {
        console.error(`${slug} failed:`, e);
        return res.status(500).json({ error: `${slug} failed`, details: e.message });
      }
    }
    // Enhanced API route handler
if (slug === "crop-image") {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: "Please upload an image file" });
  }

  const file = req.files[0];
  const inputPath = file.path;

  let { cropX, cropY, cropWidth, cropHeight } = req.body;
  
  // Parse and validate inputs
  let x = Math.max(0, parseInt(cropX, 10) || 0);
  let y = Math.max(0, parseInt(cropY, 10) || 0);
  let width = Math.max(1, parseInt(cropWidth, 10) || 100);
  let height = Math.max(1, parseInt(cropHeight, 10) || 100);

  try {
    const image = sharp(inputPath);
    const meta = await image.metadata();

    // Clamp to image bounds
    if (x >= meta.width) x = 0;
    if (y >= meta.height) y = 0;
    if (x + width > meta.width) width = meta.width - x;
    if (y + height > meta.height) height = meta.height - y;

    const origExt = path.extname(file.originalname).toLowerCase() || ".png";
    const outPath = path.join(os.tmpdir(), `cropped-${Date.now()}${origExt}`);

    await image.extract({ left: x, top: y, width, height }).toFile(outPath);

    const format = meta.format === "jpeg" ? "jpg" : meta.format;
    const mime = format ? `image/${format === "jpg" ? "jpeg" : format}` : "image/png";
    res.setHeader("Content-Type", mime);
    res.setHeader("Content-Disposition", `inline; filename="cropped-image.${format || 'png'}"`);

    res.sendFile(outPath, (err) => {
      try { fs.unlinkSync(outPath); } catch {}
      try { fs.unlinkSync(inputPath); } catch {}
      if (err) console.error("sendFile error:", err);
    });
  } catch (err) {
    console.error("Crop error:", err);
    try { fs.unlinkSync(inputPath); } catch {}
    return res.status(500).json({ error: "Image crop failed", details: err.message });
  }
  return;
}
if (slug === "pdf-add-bookmarks") {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ error: "Please upload a PDF file" });
    }

    const pdfFile = req.files.find(f => f.mimetype === "application/pdf");
    if (!pdfFile) {
      return res.status(400).json({ error: "Please upload a PDF file" });
    }

    const headingLevel = req.body.headingLevel || "all";
    const maxDepth = parseInt(req.body.maxDepth) || 3;

    const baseName = path.basename(pdfFile.originalname, path.extname(pdfFile.originalname));
    const outFile = path.join("converted", `${baseName}_with_bookmarks_${Date.now()}.pdf`);

    const scriptPath = path.join(process.cwd(), "pdf_auto_bookmarks.py");
    const pythonPath = "/app/pdfenv/bin/python3";

    const args = [
      scriptPath,
      pdfFile.path,
      outFile,
      headingLevel,
      String(maxDepth)
    ];

    // Run the Python script
    await run(pythonPath, args);

    if (!fs.existsSync(outFile)) {
      throw new Error("Bookmark generation failed: no output file created");
    }

    // Cleanup
    try {
      fs.unlinkSync(pdfFile.path);
    } catch (e) {
      console.error("Error deleting temp file:", e);
    }

    // Return the PDF file
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${baseName}_with_bookmarks.pdf"`);
    
    const fileStream = fs.createReadStream(outFile);
    fileStream.pipe(res);
    
    // Clean up after sending
    fileStream.on('close', () => {
      try {
        fs.unlinkSync(outFile);
      } catch (e) {
        console.error("Error deleting output file:", e);
      }
    });

  } catch (err) {
    console.error("Add Bookmarks Error:", err);
    
    // Clean up any temporary files
    if (req.files) {
      req.files.forEach(file => {
        try {
          fs.unlinkSync(file.path);
        } catch (e) {
          console.error("Error cleaning up file:", e);
        }
      });
    }
    
    return res.status(500).json({ 
      error: "Bookmark generation failed", 
      details: err.message 
    });
  }
}
   

    if (slug === "docx-to-png") {
      try {
        const outs = [];
    
        for (const f of req.files) {
          const output = path.join(os.tmpdir(), `${uuidv4()}.png`);
          const pages = await converters[slug](f.path, output, req);
    
          // Collect all page PNGs for this DOCX
          pages.forEach((p, i) => {
            outs.push({
              path: p,
              name: `${path.basename(f.originalname, path.extname(f.originalname))}_page_${i + 1}.png`
            });
          });
    
          await fsp.unlink(f.path).catch(() => {});
        }
    
        if (outs.length === 1) {
          // Single DOCX → single PNG
          res.download(outs[0].path, outs[0].name, async () => {
            for (const o of outs) await fsp.unlink(o.path).catch(() => {});
          });
        } else {
          // Multiple PNGs → zip
          await sendZip(res, outs, "docx_to_png.zip");
        }
        return;
      } catch (e) {
        console.error("DOCX → PNG failed:", e);
        return res.status(500).json({ error: "DOCX → PNG failed", details: e.message });
      }
    }
    

    if (slug === "remove-pages-pdf") {
      if (req.files.length !== 1) {
        return res.status(400).json({ error: "Please upload exactly one PDF file" });
      }
    
      try {
        const input = req.files[0].path;
        const output = path.join(os.tmpdir(), "removed.pdf");
        await converters[slug](input, output, req);
    
        res.download(output, "removed.pdf", async () => {
          await fsp.unlink(output).catch(() => {});
          await fsp.unlink(input).catch(() => {});
        });
        return;
      } catch (e) {
        console.error("Remove pages failed:", e);
        return res.status(500).json({ error: "Remove pages failed", details: e.message });
      }
    }


    // Add to your existing conversion API endpoint

if (slug === "extract-pdf-images") {
  if (req.files.length !== 1) {
    return res.status(400).json({ error: "Please upload exactly one PDF file" });
  }

  try {
    const input = req.files[0].path;
    const output = path.join(os.tmpdir(), `${uuidv4()}.zip`);
    
    console.log(`Starting extraction for: ${input}`);
    await converters[slug](input, output, req);

    // Check if output file was created
    if (!fs.existsSync(output)) {
      throw new Error("Output ZIP file was not created");
    }

    const stats = fs.statSync(output);
    console.log(`ZIP file created: ${output} (${stats.size} bytes)`);

    // Generate a better filename
    const originalName = req.files[0].originalname;
    const baseName = path.basename(originalName, path.extname(originalName));
    const downloadName = `${baseName}-extracted-images.zip`;
    
    // Set proper headers
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
    res.setHeader('Content-Length', stats.size);
    
    // Stream the file
    const fileStream = fs.createReadStream(output);
    fileStream.pipe(res);
    
    // Clean up after streaming is done
    fileStream.on('close', async () => {
      try {
        await fsp.unlink(output).catch(() => {});
        await fsp.unlink(input).catch(() => {});
        console.log(`Cleaned up temporary files: ${output}, ${input}`);
      } catch (cleanupError) {
        console.error('Cleanup error:', cleanupError);
      }
    });
    
    fileStream.on('error', async (error) => {
      console.error('Stream error:', error);
      try {
        await fsp.unlink(output).catch(() => {});
        await fsp.unlink(input).catch(() => {});
      } catch (cleanupError) {
        console.error('Cleanup error after stream failure:', cleanupError);
      }
    });
    
  } catch (e) {
    console.error("Image extraction failed:", e);
    
    // Clean up on error
    try {
      if (input) await fsp.unlink(input).catch(() => {});
      if (output && fs.existsSync(output)) await fsp.unlink(output).catch(() => {});
    } catch (cleanupError) {
      console.error('Cleanup error after extraction failure:', cleanupError);
    }
    
    return res.status(500).json({ 
      error: "Failed to extract images from PDF", 
      details: e.message 
    });
  }
}

// Add to your conversion API endpoint

    // Inside the conversion API endpoint, add this special case for pdf-split
if (slug === "pdf-split") {
  const splitOption = req.body.splitOption;
  const pageRanges = req.body.pageRanges;
  
  if (req.files.length !== 1) {
    return res.status(400).json({ error: "Please upload exactly one PDF file for splitting" });
  }
  
  try {
    const input = req.files[0].path;
    const outputDir = path.join(os.tmpdir(), uuidv4());
    await fsp.mkdir(outputDir);
    const output = path.join(outputDir, "output.pdf");
    
    // Call the pdf-split handler with additional parameters
    const outputFiles = await converters[slug](input, output, req);
    
    // Create zip with all split files
    const originalName = req.files[0].originalname;
    const baseName = path.basename(originalName, path.extname(originalName));
    
    const filesForZip = outputFiles.map((filePath, index) => {
      const ext = path.extname(filePath);
      let fileName;
      
      if (splitOption === 'custom') {
        fileName = `${baseName}_range_${String(index + 1).padStart(3, '0')}${ext}`;
      } else {
        fileName = `${baseName}_page_${String(index + 1).padStart(3, '0')}${ext}`;
      }
      
      return { path: filePath, name: fileName };
    });
    
    await sendZip(res, filesForZip, `${baseName}_split.zip`);
    
    // Cleanup
    await fsp.rm(outputDir, { recursive: true }).catch(() => {});
    await fsp.unlink(input).catch(() => {});
    
    return;
  } catch (e) {
    console.error(`PDF split failed:`, e);
    res.status(500).json({ error: "PDF split failed", details: e.message });
  }
}

if (slug === "pdf-merge") {
  try {
    const inputs = req.files.map(f => f.path);
    const output = path.join(os.tmpdir(), "merge.pdf");

    await converters["pdf-merge"](inputs, output);

    res.download(output, "merge.pdf", async () => {
      await fsp.unlink(output).catch(() => {});
      for (const f of inputs) await fsp.unlink(f.path).catch(() => {});
    });
    return;
  } catch (e) {
    console.error("PDF merge failed:", e);
    return res.status(500).json({ error: "PDF merge failed", details: e.message });
  }
}

    if (req.files.length === 1) {
      const input = req.files[0].path;
      const output = path.join(os.tmpdir(), `${uuidv4()}.${targetExt}`);
      await handler(input, output);
      
      // Generate a better filename
      const originalName = req.files[0].originalname;
      const baseName = path.basename(originalName, path.extname(originalName));
      const downloadName = `${baseName}.${targetExt}`;
      
      res.download(output, downloadName, async () => {
        await fsp.unlink(output).catch(() => {});
        await fsp.unlink(input).catch(() => {});
      });
    } 
    // Multiple files → zip
    else {
      const outs = [];
      for (const f of req.files) {
        const name = path.basename(f.originalname, path.extname(f.originalname)) + `.${targetExt}`;
        const outPath = path.join(os.tmpdir(), `${uuidv4()}.${targetExt}`);
        await handler(f.path, outPath);
        outs.push({ path: outPath, name });
        await fsp.unlink(f.path).catch(() => {});
      }
      await sendZip(res, outs);
    }
  } catch (e) {
    console.error(`Conversion failed for ${slug}:`, e);
    res.status(500).json({ error: "Conversion failed", details: e.message });
  }
});


// Serve main index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});


// Serve tool HTML pages without .html in URL
app.get("/:slug", (req, res, next) => {
  const filePath = path.join(__dirname, "public", "tools", `${req.params.slug}.html`);
  res.sendFile(filePath, (err) => {
    if (err) next(); // Pass to next route (so /api/... still works)
  });
});

// 404 fallback (optional)
app.use((req, res) => {
  res.status(404).send("Page not found");
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
