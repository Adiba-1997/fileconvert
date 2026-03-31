import sys
import os
from PyPDF2 import PdfReader, PdfWriter
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import letter, A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.units import mm
from io import BytesIO
import decimal

def get_page_size(pdf_reader):
    """Get the page size of the PDF"""
    first_page = pdf_reader.pages[0]
    if hasattr(first_page, 'mediabox'):
        width = float(first_page.mediabox.width)
        height = float(first_page.mediabox.height)
        return width, height
    return letter  # Default to letter size

def add_page_numbers(input_path, output_path, position="bottom-center", start_num=1, format="number", font_size=12):
    """
    Add page numbers to a PDF document
    
    Args:
        input_path: Path to the input PDF file
        output_path: Path to the output PDF file
        position: Position of page numbers (bottom-center, bottom-right, bottom-left, top-center, top-right, top-left)
        start_num: Starting page number
        format: Number format ("number", "page x of y")
        font_size: Font size for page numbers
    """
    
    # Read the input PDF
    with open(input_path, 'rb') as file:
        pdf_reader = PdfReader(file)
        pdf_writer = PdfWriter()
        
        # Get page size
        page_width, page_height = get_page_size(pdf_reader)
        
        total_pages = len(pdf_reader.pages)
        
        for i, page in enumerate(pdf_reader.pages):
            # Create a PDF with page number
            packet = BytesIO()
            can = canvas.Canvas(packet, pagesize=(page_width, page_height))
            can.setFont("Helvetica", font_size)
            
            # Determine position coordinates
            if "bottom" in position:
                y = 20  # 20 points from bottom
            else:  # top
                y = float(page_height) - 20  # 20 points from top
            
            if "center" in position:
                x = float(page_width) / 2
            elif "right" in position:
                x = float(page_width) - 40  # 40 points from right
            else:  # left
                x = 40  # 40 points from left
            
            # Convert coordinates to float to avoid Decimal issues
            x = float(x)
            y = float(y)
            
            # Format the page number text
            if format == "page x of y":
                text = f"Page {start_num + i} of {total_pages}"
            else:
                text = str(start_num + i)
            
            # Draw the page number
            can.drawCentredString(x, y, text)
            can.save()
            
            # Move to the beginning of the BytesIO buffer
            packet.seek(0)
            
            # Create a PDF with the page number
            number_pdf = PdfReader(packet)
            number_page = number_pdf.pages[0]
            
            # Merge the page number with the original page
            page.merge_page(number_page)
            
            # Add the page to the writer
            pdf_writer.add_page(page)
        
        # Write the output PDF
        with open(output_path, 'wb') as output_file:
            pdf_writer.write(output_file)

def main():
    if len(sys.argv) < 3:
        print("Usage: python pdf_numbering.py input.pdf output.pdf [position] [start_num] [format] [font_size]")
        sys.exit(1)
    
    input_path = sys.argv[1]
    output_path = sys.argv[2]
    
    # Default values
    position = "bottom-center"
    start_num = 1
    format = "number"
    font_size = 12
    
    # Parse optional arguments
    if len(sys.argv) > 3:
        position = sys.argv[3]
    if len(sys.argv) > 4:
        start_num = int(sys.argv[4])
    if len(sys.argv) > 5:
        format = sys.argv[5]
    if len(sys.argv) > 6:
        font_size = int(sys.argv[6])
    
    # Validate position
    valid_positions = ["bottom-center", "bottom-right", "bottom-left", 
                      "top-center", "top-right", "top-left"]
    if position not in valid_positions:
        print(f"Invalid position: {position}. Using default: bottom-center")
        position = "bottom-center"
    
    # Validate format
    valid_formats = ["number", "page x of y"]
    if format not in valid_formats:
        print(f"Invalid format: {format}. Using default: number")
        format = "number"
    
    # Add page numbers
    add_page_numbers(input_path, output_path, position, start_num, format, font_size)
    print(f"Page numbers added successfully. Output saved to: {output_path}")

if __name__ == "__main__":
    main()
