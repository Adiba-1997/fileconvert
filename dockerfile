FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

# Install system dependencies
RUN apt-get update && apt-get install -y \
    nodejs npm \
    libreoffice \
    tesseract-ocr \
    poppler-utils \
    ghostscript \
    imagemagick \
    unrar \
    python3 python3-pip python3-venv \
    wget curl \
    && rm -rf /var/lib/apt/lists/*

# Set working directory
WORKDIR /app

# Copy project files
COPY . .

# Setup Python virtual environment
RUN python3 -m venv /app/pdfenv
RUN /app/pdfenv/bin/pip install --upgrade pip

RUN /app/pdfenv/bin/pip install \
    pytesseract \
    pdf2image \
    pandas \
    openpyxl \
    pillow \
    pdf2docx \
    opencv-python

# Install Node dependencies
RUN npm install

# Set PORT (Render uses 10000)
ENV PORT=10000

# Expose port
EXPOSE 10000

# Start app
CMD ["node", "server.js"]