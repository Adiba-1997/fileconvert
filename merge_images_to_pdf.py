#!/usr/bin/env python3
import os
import sys
import json
import tempfile
from flask import Flask, request, jsonify, send_file
from werkzeug.utils import secure_filename
from PIL import Image
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4

app = Flask(__name__)

# Configuration
ALLOWED_EXTENSIONS = {'png', 'jpg', 'jpeg'}
MAX_FILE_SIZE = 10 * 1024 * 1024  # 10MB
MAX_FILES = 20

def allowed_file(filename):
    return '.' in filename and \
           filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

def merge_images_to_pdf(image_paths, output_pdf):
    """
    Merge multiple images into a single PDF file
    """
    try:
        print(f"Merging {len(image_paths)} images to PDF: {output_pdf}")
        
        # Validate input images
        valid_image_paths = []
        for img_path in image_paths:
            if not os.path.exists(img_path):
                print(f"Warning: Image file {img_path} does not exist, skipping")
                continue
            try:
                # Try to open the image to verify it's valid
                with Image.open(img_path) as img:
                    img.verify()  # Verify it's a valid image
                valid_image_paths.append(img_path)
            except Exception as e:
                print(f"Warning: Invalid image file {img_path}: {e}, skipping")
        
        if not valid_image_paths:
            print("Error: No valid images found to merge")
            return False
        
        # Create PDF
        c = canvas.Canvas(output_pdf, pagesize=A4)
        page_width, page_height = A4
        
        for img_path in valid_image_paths:
            try:
                # Open image and get dimensions
                img = Image.open(img_path)
                img_width, img_height = img.size
                
                # Calculate scaling to fit page
                width_ratio = page_width / img_width
                height_ratio = page_height / img_height
                scale = min(width_ratio, height_ratio) * 0.95  # 5% margin
                
                # Calculate position to center image
                scaled_width = img_width * scale
                scaled_height = img_height * scale
                x = (page_width - scaled_width) / 2
                y = (page_height - scaled_height) / 2
                
                # Draw image on PDF
                c.drawImage(img_path, x, y, width=scaled_width, height=scaled_height, preserveAspectRatio=True)
                c.showPage()  # Create new page for next image
                
                img.close()  # Close the image file
                
            except Exception as e:
                print(f"Error processing image {img_path}: {e}")
                continue
        
        # Save PDF
        c.save()
        print(f"Successfully created PDF with {len(valid_image_paths)} images")
        return True
        
    except Exception as e:
        print(f"Error during PDF creation: {str(e)}")
        import traceback
        traceback.print_exc()
        return False

@app.route('/api/convert/merge-images-to-pdf', methods=['POST'])
def handle_merge_images_to_pdf():
    """
    API endpoint to merge multiple images into a PDF
    """
    try:
        # Check if files were uploaded
        if 'files' not in request.files:
            return jsonify({'error': 'No files uploaded'}), 400
        
        files = request.files.getlist('files')
        
        # Validate file count
        if len(files) == 0:
            return jsonify({'error': 'No files uploaded'}), 400
        
        if len(files) > MAX_FILES:
            return jsonify({'error': f'Maximum {MAX_FILES} files allowed'}), 400
        
        # Create temporary directory for processing
        with tempfile.TemporaryDirectory() as temp_dir:
            image_paths = []
            
            # Save uploaded files
            for file in files:
                if file.filename == '':
                    continue
                
                if file and allowed_file(file.filename):
                    filename = secure_filename(file.filename)
                    file_path = os.path.join(temp_dir, filename)
                    file.save(file_path)
                    
                    # Check file size
                    if os.path.getsize(file_path) > MAX_FILE_SIZE:
                        return jsonify({'error': f'File {filename} exceeds size limit'}), 400
                    
                    image_paths.append(file_path)
            
            if not image_paths:
                return jsonify({'error': 'No valid image files uploaded'}), 400
            
            # Create output PDF
            output_pdf = os.path.join(temp_dir, 'merged.pdf')
            
            if not merge_images_to_pdf(image_paths, output_pdf):
                return jsonify({'error': 'Failed to create PDF'}), 500
            
            # Return the PDF file
            return send_file(
                output_pdf,
                as_attachment=True,
                download_name='merged-images.pdf',
                mimetype='application/pdf'
            )
    
    except Exception as e:
        print(f"API error: {str(e)}")
        import traceback
        traceback.print_exc()
        return jsonify({'error': 'Internal server error'}), 500

if __name__ == '__main__':
    # Run the Flask app
    app.run(host='0.0.0.0', port=5001, debug=False)
