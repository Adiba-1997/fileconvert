import sys
import json
from PyPDF2 import PdfReader, PdfWriter
from PyPDF2.generic import Destination, NameObject, NumberObject, IndirectObject
import re

def extract_text_from_pdf(pdf_path):
    """Extract text from PDF with basic formatting info"""
    text_content = []
    
    with open(pdf_path, 'rb') as file:
        reader = PdfReader(file)
        
        for page_num, page in enumerate(reader.pages, 1):
            try:
                text = page.extract_text()
                if text:
                    lines = text.split('\n')
                    for line in lines:
                        if line.strip():  # Only add non-empty lines
                            text_content.append({
                                'text': line.strip(),
                                'page': page_num,
                                'type': 'unknown'
                            })
            except Exception as e:
                print(f"Warning: Could not extract text from page {page_num}: {str(e)}")
    
    return text_content

def detect_headings(text_content, heading_level="all"):
    """Detect potential headings in extracted text"""
    headings = []
    
    # Patterns that might indicate headings
    heading_patterns = [
        r'^(chapter|section|part|appendix)\s+\d+',  # Chapter 1, Section 2, etc.
        r'^\d+(\.\d+)*\s+[A-Z]',  # 1. Introduction, 1.1. Overview, etc.
        r'^[IVX]+\.',  # Roman numerals: I., II., III.
        r'^[A-Z][A-Z\s]{2,50}$',  # ALL CAPS lines of reasonable length
    ]
    
    for item in text_content:
        text = item['text']
        page = item['page']
        
        # Skip very long lines (likely not headings)
        if len(text) > 100:
            continue
            
        # Check against heading patterns
        is_heading = False
        level = 1
        
        for i, pattern in enumerate(heading_patterns):
            if re.match(pattern, text, re.IGNORECASE):
                is_heading = True
                level = i + 1
                break
                
        # Additional checks for headings
        if not is_heading:
            # Lines that are short and start with a number or capital letter
            if (len(text) < 50 and 
                (text[0].isupper() or text[0].isdigit()) and
                not text.endswith('.') and  # Less likely to be full sentences
                not any(word in text.lower() for word in ['the', 'and', 'but', 'however'])):
                is_heading = True
                level = 3
                
        if is_heading:
            headings.append({
                'title': text,
                'page': page,
                'level': min(level, 6)  # Cap at level 6
            })
    
    return headings

def add_bookmarks_to_pdf(input_path, output_path, headings):
    """Add bookmarks to PDF based on detected headings"""
    try:
        with open(input_path, 'rb') as file:
            reader = PdfReader(file)
            writer = PdfWriter()
            
            # Add all pages to writer
            for page in reader.pages:
                writer.add_page(page)
            
            # Add bookmarks
            parent_stack = []  # Stack to track parent bookmarks at each level
            
            for heading in headings:
                page_num = heading['page'] - 1  # Convert to 0-based index
                level = heading['level']
                
                if page_num < 0 or page_num >= len(reader.pages):
                    print(f"Warning: Invalid page number {page_num + 1} for heading '{heading['title']}'")
                    continue
                
                # Get page reference
                page_ref = writer.pages[page_num]
                
                # Create destination using the new PyPDF2 API
                # For newer versions of PyPDF2, we need to create the destination differently
                try:
                    # Try the new API first
                    bookmark_ref = writer.add_outline_item(
                        title=heading['title'],
                        page_number=page_num,
                        parent=None,
                        color=None,
                        bold=False,
                        italic=False
                    )
                except Exception as e:
                    print(f"Error adding bookmark with new API: {e}")
                    # Fallback to basic method
                    try:
                        bookmark_ref = writer.add_bookmark(
                            title=heading['title'],
                            pagenum=page_num,
                            parent=None
                        )
                    except Exception as e2:
                        print(f"Also failed with fallback method: {e2}")
                        continue
                
                # Handle bookmark hierarchy
                while len(parent_stack) >= level:
                    parent_stack.pop()
                
                parent = parent_stack[-1] if parent_stack else None
                
                # For hierarchy, we would need to set parent, but this is complex
                # in newer PyPDF2 versions. For now, we'll add all as top-level.
                
                # Update parent stack
                if level <= len(parent_stack):
                    parent_stack[level - 1] = bookmark_ref
                else:
                    parent_stack.append(bookmark_ref)
            
            # Write output file
            with open(output_path, 'wb') as output_file:
                writer.write(output_file)
                
            return True
            
    except Exception as e:
        print(f"ERROR in add_bookmarks_to_pdf: {str(e)}")
        import traceback
        traceback.print_exc()
        return False

def create_simple_bookmarks(input_path, output_path):
    """Create simple page number bookmarks as fallback"""
    try:
        with open(input_path, 'rb') as file:
            reader = PdfReader(file)
            writer = PdfWriter()
            
            # Add all pages to writer
            for page in reader.pages:
                writer.add_page(page)
            
            # Add simple page number bookmarks
            for i in range(len(reader.pages)):
                try:
                    writer.add_outline_item(
                        title=f"Page {i+1}",
                        page_number=i
                    )
                except:
                    # Fallback for older PyPDF2 versions
                    writer.add_bookmark(f"Page {i+1}", i)
            
            # Write output file
            with open(output_path, 'wb') as output_file:
                writer.write(output_file)
                
            return True
            
    except Exception as e:
        print(f"ERROR in create_simple_bookmarks: {str(e)}")
        return False

def main():
    if len(sys.argv) < 3:
        print("ERROR: Usage: python pdf_auto_bookmarks.py input.pdf output.pdf [heading_level] [max_depth]")
        sys.exit(1)
    
    input_path = sys.argv[1]
    output_path = sys.argv[2]
    heading_level = sys.argv[3] if len(sys.argv) > 3 else "all"
    max_depth = int(sys.argv[4]) if len(sys.argv) > 4 else 3
    
    try:
        # Step 1: Extract text from PDF
        print("Extracting text from PDF...")
        text_content = extract_text_from_pdf(input_path)
        
        if not text_content:
            print("WARNING: Could not extract any text from the PDF. Creating basic bookmarks...")
            success = create_simple_bookmarks(input_path, output_path)
            if success:
                print(f"SUCCESS: Created basic page bookmarks. Output: {output_path}")
            else:
                print("ERROR: Failed to create basic bookmarks")
            sys.exit(0 if success else 1)
        
        # Step 2: Detect headings
        print("Detecting headings...")
        headings = detect_headings(text_content, heading_level)
        
        if not headings:
            print("WARNING: No headings detected. Creating basic page number bookmarks...")
            success = create_simple_bookmarks(input_path, output_path)
            if success:
                print(f"SUCCESS: Created basic page bookmarks. Output: {output_path}")
            else:
                print("ERROR: Failed to create basic bookmarks")
            sys.exit(0 if success else 1)
        
        # Apply max depth filter
        headings = [h for h in headings if h['level'] <= max_depth]
        
        print(f"Found {len(headings)} potential headings")
        
        # Step 3: Add bookmarks to PDF
        print("Adding bookmarks to PDF...")
        success = add_bookmarks_to_pdf(input_path, output_path, headings)
        
        if success:
            print(f"SUCCESS: Added {len(headings)} bookmarks. Output: {output_path}")
        else:
            print("WARNING: Failed to add detected bookmarks. Trying basic bookmarks...")
            success = create_simple_bookmarks(input_path, output_path)
            if success:
                print(f"SUCCESS: Created basic page bookmarks. Output: {output_path}")
            else:
                print("ERROR: Failed to create any bookmarks")
                sys.exit(1)
            
    except Exception as e:
        print(f"ERROR: {str(e)}")
        import traceback
        traceback.print_exc()
        sys.exit(1)

if __name__ == "__main__":
    main()
