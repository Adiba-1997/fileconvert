#!/home/ubuntu/pdfenv/bin/python3
import sys
import os
from PIL import Image
import pillow_heif

def heic_to_png(input_path, output_path, quality, resize, preserve_exif):
    # Register HEIF opener
    pillow_heif.register_heif_opener()
    
    # Open HEIC image
    try:
        img = Image.open(input_path)
    except Exception as e:
        print(f"Error opening HEIC file: {e}")
        return False
    
    # Handle resizing
    if resize != "original":
        max_size = int(resize)
        width, height = img.size
        
        if width > max_size or height > max_size:
            if width > height:
                new_width = max_size
                new_height = int(height * (max_size / width))
            else:
                new_height = max_size
                new_width = int(width * (max_size / height))
            
            img = img.resize((new_width, new_height), Image.LANCZOS)
    
    # Set compression level based on quality
    compression_level = 6  # Default
    if quality == "high":
        compression_level = 9
    elif quality == "medium":
        compression_level = 6
    elif quality == "low":
        compression_level = 3
    elif quality == "lossless":
        compression_level = 0  # No compression
    
    # Save as PNG
    try:
        save_kwargs = {'compress_level': compression_level}
        
        # Preserve EXIF data if requested
        if preserve_exif.lower() == 'true' and hasattr(img, 'getexif'):
            exif = img.getexif()
            if exif:
                save_kwargs['exif'] = exif
        
        img.save(output_path, 'PNG', **save_kwargs)
        return True
    except Exception as e:
        print(f"Error saving PNG file: {e}")
        return False

if __name__ == "__main__":
    if len(sys.argv) < 6:
        print("Usage: python heic_to_png.py <input> <output> <quality> <resize> <preserve_exif>")
        sys.exit(1)
    
    input_path = sys.argv[1]
    output_path = sys.argv[2]
    quality = sys.argv[3]
    resize = sys.argv[4]
    preserve_exif = sys.argv[5]
    
    success = heic_to_png(input_path, output_path, quality, resize, preserve_exif)
    sys.exit(0 if success else 1)
