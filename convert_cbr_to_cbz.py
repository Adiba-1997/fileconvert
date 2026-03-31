import os
import sys
import zipfile
import tempfile
import shutil
import subprocess

def convert_cbr_to_cbz(input_file, output_file):
    if not input_file.lower().endswith(".cbr"):
        raise ValueError("Input file must be a .cbr archive")

    temp_dir = tempfile.mkdtemp()

    try:
        # Extract using unrar
        subprocess.run(["unrar", "x", "-y", input_file, temp_dir], check=True)

        # Create CBZ (zip file)
        with zipfile.ZipFile(output_file, 'w', zipfile.ZIP_DEFLATED) as zipf:
            for root, _, files in os.walk(temp_dir):
                for file in files:
                    file_path = os.path.join(root, file)
                    arcname = os.path.relpath(file_path, temp_dir)
                    zipf.write(file_path, arcname)

    finally:
        shutil.rmtree(temp_dir)

if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage: python convert_cbr_to_cbz.py input.cbr output.cbz")
        sys.exit(1)

    input_file = sys.argv[1]
    output_file = sys.argv[2]

    try:
        convert_cbr_to_cbz(input_file, output_file)
        print("SUCCESS")
    except Exception as e:
        print(f"ERROR: {e}")
        sys.exit(1)
