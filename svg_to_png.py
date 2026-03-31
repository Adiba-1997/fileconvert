#!/usr/bin/env python3
import sys
import os
from cairosvg import svg2png

def svg_to_png(svg_path, png_path):
    """
    Convert SVG to PNG using CairoSVG
    """
    try:
        print(f"Converting: {svg_path} -> {png_path}")
        
        # Check if input file exists
        if not os.path.exists(svg_path):
            print(f"Error: Input file {svg_path} does not exist")
            return False
        
        # Convert SVG to PNG
        with open(svg_path, 'rb') as svg_file:
            svg_content = svg_file.read()
        
        svg2png(bytestring=svg_content, write_to=png_path)
        
        # Verify the PNG was created
        if os.path.exists(png_path) and os.path.getsize(png_path) > 0:
            print(f"Successfully created PNG: {png_path}")
            return True
        else:
            print("PNG creation failed")
            return False
            
    except Exception as e:
        print(f"Error during conversion: {str(e)}")
        import traceback
        traceback.print_exc()
        return False

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python svg_to_png.py <input_svg> <output_png>")
        sys.exit(1)
    
    input_svg = sys.argv[1]
    output_png = sys.argv[2]
    
    success = svg_to_png(input_svg, output_png)
    
    if success:
        print("Conversion completed successfully")
        sys.exit(0)
    else:
        print("Conversion failed")
        sys.exit(1)
