#!/usr/bin/env python3
import sys
import os
from cairosvg import svg2png
from PIL import Image
import tempfile

def svg_to_jpg(svg_path, jpg_path, quality=90):
    """
    Convert SVG to JPG using CairoSVG and PIL
    """
    try:
        print(f"Converting: {svg_path} -> {jpg_path}")
        
        # Check if input file exists
        if not os.path.exists(svg_path):
            print(f"Error: Input file {svg_path} does not exist")
            return False
        
        # Create a temporary file for PNG conversion
        with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tmp:
            png_path = tmp.name
        
        # Convert SVG to PNG first
        with open(svg_path, 'rb') as svg_file:
            svg_content = svg_file.read()
        
        svg2png(bytestring=svg_content, write_to=png_path)
        
        # Check if PNG was created successfully
        if not os.path.exists(png_path) or os.path.getsize(png_path) == 0:
            print("PNG conversion failed")
            return False
        
        # Convert PNG to JPG
        img = Image.open(png_path)
        
        # Convert RGBA to RGB if needed (JPG doesn't support transparency)
        if img.mode in ('RGBA', 'LA'):
            # Create a white background
            background = Image.new('RGB', img.size, (255, 255, 255))
            # Paste the image on white background
            if img.mode == 'RGBA':
                background.paste(img, mask=img.split()[3])  # Use alpha channel as mask
            else:
                background.paste(img, mask=img.split()[1])  # Use luminance alpha as mask
            img = background
        
        # Save as JPG with specified quality
        img.save(jpg_path, 'JPEG', quality=quality)
        
        # Clean up temporary PNG file
        os.unlink(png_path)
        
        # Verify the JPG was created
        if os.path.exists(jpg_path) and os.path.getsize(jpg_path) > 0:
            print(f"Successfully created JPG: {jpg_path}")
            return True
        else:
            print("JPG creation failed")
            return False
            
    except Exception as e:
        print(f"Error during conversion: {str(e)}")
        import traceback
        traceback.print_exc()
        
        # Clean up temporary files if they exist
        if 'png_path' in locals() and os.path.exists(png_path):
            try:
                os.unlink(png_path)
            except:
                pass
        return False

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python svg_to_jpg.py <input_svg> <output_jpg> [quality]")
        sys.exit(1)
    
    input_svg = sys.argv[1]
    output_jpg = sys.argv[2]
    quality = int(sys.argv[3]) if len(sys.argv) > 3 else 90
    
    success = svg_to_jpg(input_svg, output_jpg, quality)
    
    if success:
        print("Conversion completed successfully")
        sys.exit(0)
    else:
        print("Conversion failed")
        sys.exit(1)
