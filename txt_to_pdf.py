#!/usr/bin/env python3
import sys
import os
from fpdf import FPDF

def txt_to_pdf(txt_path, pdf_path):
    """
    Convert text file to PDF with proper error handling
    """
    try:
        print(f"Starting conversion: {txt_path} -> {pdf_path}")
        
        # Check if input file exists
        if not os.path.exists(txt_path):
            print(f"Error: Input file {txt_path} does not exist")
            return False
        
        # Read the text file with multiple encoding attempts
        text_content = None
        encodings = ['utf-8', 'latin-1', 'iso-8859-1', 'cp1252', 'utf-8-sig']
        
        for encoding in encodings:
            try:
                with open(txt_path, 'r', encoding=encoding) as f:
                    text_content = f.read()
                print(f"Successfully read file with {encoding} encoding")
                break
            except UnicodeDecodeError:
                continue
            except Exception as e:
                print(f"Error with {encoding}: {e}")
                continue
        
        # If all encodings failed, try binary read with replacement
        if text_content is None:
            try:
                with open(txt_path, 'rb') as f:
                    binary_data = f.read()
                text_content = binary_data.decode('utf-8', errors='replace')
                print("Used binary read with error replacement")
            except Exception as e:
                print(f"Failed to read file: {e}")
                return False
        
        # Create PDF
        pdf = FPDF()
        pdf.set_auto_page_break(auto=True, margin=15)
        pdf.add_page()
        
        # Set font
        pdf.set_font("Arial", size=12)
        
        # Add content with proper line handling (NO TITLE LINE)
        lines = text_content.split('\n')
        for i, line in enumerate(lines):
            if i > 0:
                pdf.ln(5)  # Add spacing between lines
            
            # Handle long lines by splitting them
            if len(line) > 100:
                # Split long line into chunks
                chunks = [line[i:i+80] for i in range(0, len(line), 80)]
                for chunk in chunks:
                    pdf.cell(0, 10, txt=chunk, ln=True)
            else:
                pdf.multi_cell(0, 10, txt=line)
        
        # Save PDF
        pdf.output(pdf_path)
        print(f"Successfully created PDF: {pdf_path}")
        
        # Verify the PDF was created
        if os.path.exists(pdf_path) and os.path.getsize(pdf_path) > 0:
            print("PDF verification passed")
            return True
        else:
            print("PDF verification failed")
            return False
            
    except Exception as e:
        print(f"Error during conversion: {str(e)}")
        import traceback
        traceback.print_exc()
        return False

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python txt_to_pdf.py <input_txt> <output_pdf>")
        sys.exit(1)
    
    input_txt = sys.argv[1]
    output_pdf = sys.argv[2]
    
    success = txt_to_pdf(input_txt, output_pdf)
    
    if success:
        print("Conversion completed successfully")
        sys.exit(0)
    else:
        print("Conversion failed")
        sys.exit(1)
