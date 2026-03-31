#!/home/ubuntu/pdfenv/bin/python3
import sys
import os
from weasyprint import HTML

def convert_html_to_pdf(input_path, output_path):
    """Convert HTML file to PDF using WeasyPrint"""
    try:
        # Convert HTML to PDF
        HTML(input_path).write_pdf(output_path)
        
        # Verify output was created
        if os.path.exists(output_path) and os.path.getsize(output_path) > 0:
            return True
        else:
            return False
            
    except Exception as e:
        print(f"Error: {e}")
        return False

def main():
    if len(sys.argv) != 3:
        print("Usage: python html_to_pdf.py <input_html> <output_pdf>")
        sys.exit(1)
    
    input_file = sys.argv[1]
    output_file = sys.argv[2]
    
    if not os.path.exists(input_file):
        print(f"ERROR: Input file does not exist: {input_file}")
        sys.exit(1)
    
    if convert_html_to_pdf(input_file, output_file):
        print("SUCCESS:PDF converted successfully")
    else:
        print("ERROR:Failed to convert HTML to PDF")
        sys.exit(1)

if __name__ == "__main__":
    main()
