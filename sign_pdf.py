import sys
import os
import base64
from io import BytesIO
from PyPDF2 import PdfReader, PdfWriter
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.utils import ImageReader
from PIL import Image

def create_signature_image(image_path, width=120, height=60):
    """Process and resize signature image"""
    img = Image.open(image_path)
    img.thumbnail((width, height), Image.Resampling.LANCZOS)
    
    # Convert to RGBA if not already
    if img.mode != 'RGBA':
        img = img.convert('RGBA')
    
    # Save to bytes buffer
    buffer = BytesIO()
    img.save(buffer, format='PNG')
    buffer.seek(0)
    return buffer

def create_signature_page(text, font_name="Helvetica", position="bottom-right", width=200, height=50):
    """Create a PDF page with the signature text"""
    packet = BytesIO()
    can = canvas.Canvas(packet, pagesize=letter)

    # Register font if available
    font_path = f"/home/ubuntu/fileconvert/fonts/{font_name}.ttf"
    if os.path.exists(font_path):
        pdfmetrics.registerFont(TTFont(font_name, font_path))
    else:
        font_name = "Helvetica"

    page_width, page_height = letter
    font_size = 20
    can.setFont(font_name, font_size)

    # Position logic
    if position == "bottom-right":
        x, y = page_width - width - 50, 50
    elif position == "bottom-left":
        x, y = 50, 50
    elif position == "top-right":
        x, y = page_width - width - 50, page_height - 100
    else:  # top-left
        x, y = 50, page_height - 100

    can.drawString(x, y, text)
    can.save()
    packet.seek(0)
    return PdfReader(packet)

def create_drawn_signature(data_url, position="bottom-right", width=120, height=60):
    """Create a PDF page with a drawn signature"""
    # Extract base64 data from data URL
    header, encoded = data_url.split(",", 1)
    image_data = base64.b64decode(encoded)
    
    packet = BytesIO()
    can = canvas.Canvas(packet, pagesize=letter)
    
    page_width, page_height = letter
    
    # Position logic
    if position == "bottom-right":
        x, y = page_width - width - 50, 50
    elif position == "bottom-left":
        x, y = 50, 50
    elif position == "top-right":
        x, y = page_width - width - 50, page_height - 100
    else:  # top-left
        x, y = 50, page_height - 100
    
    # Draw the image
    img_reader = ImageReader(BytesIO(image_data))
    can.drawImage(img_reader, x, y, width, height, preserveAspectRatio=True)
    can.save()
    packet.seek(0)
    return PdfReader(packet)

def main():
    # Args from Node
    if len(sys.argv) < 9:
        print("Insufficient arguments")
        sys.exit(1)
        
    script, inp, out, sigType, signatureData, typedSignature, signatureFont, signaturePosition, pageNumber, *rest = sys.argv

    reader = PdfReader(inp)
    writer = PdfWriter()
    page_num = int(pageNumber) - 1  # Convert to 0-based index

    # Validate page number
    if page_num < 0 or page_num >= len(reader.pages):
        page_num = 0  # Default to first page if invalid

    # Choose signature type
    sig_pdf = None
    if sigType == "type" and typedSignature:
        sig_pdf = create_signature_page(typedSignature, signatureFont, signaturePosition)
    elif sigType == "draw" and signatureData:
        sig_pdf = create_drawn_signature(signatureData, signaturePosition)
    elif sigType == "upload" and rest:
        # Process uploaded signature image
        sig_image_path = rest[0]
        sig_buffer = create_signature_image(sig_image_path)
        sig_pdf = create_drawn_signature(f"data:image/png;base64,{base64.b64encode(sig_buffer.getvalue()).decode()}", signaturePosition)

    # Apply signature to the selected page
    for i, page in enumerate(reader.pages):
        if i == page_num and sig_pdf:
            page.merge_page(sig_pdf.pages[0])
        writer.add_page(page)

    # Write output file
    with open(out, "wb") as f:
        writer.write(f)

if __name__ == "__main__":
    main()
