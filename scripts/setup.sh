#!/bin/bash

# Nexa Scraper 环境设置脚本
PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export NEXA_CONFIG="$PROJECT_ROOT/config/default.yaml"
echo "NEXA_CONFIG set to $NEXA_CONFIG"

set -e

echo "================================"
echo "Nexa Scraper Setup"
echo "================================"

# 检查 Node.js 版本
echo ""
echo "Checking Node.js version..."
NODE_VERSION=$(node -v | cut -d'v' -f2)
REQUIRED_VERSION="20.0.0"

if [ "$(printf '%s\n' "$REQUIRED_VERSION" "$NODE_VERSION" | sort -V | head -n1)" != "$REQUIRED_VERSION" ]; then 
    echo "❌ Node.js version $NODE_VERSION is too old. Please upgrade to $REQUIRED_VERSION or later."
    exit 1
fi

echo "✓ Node.js $NODE_VERSION"

# 安装依赖
echo ""
echo "Installing dependencies..."
npm install

# 安装 Playwright 浏览器
echo ""
echo "Installing Playwright browsers..."
npx playwright install chromium

# 创建必要目录
echo ""
echo "Creating directories..."
mkdir -p data/cookies data/raw logs tmp debug

# 复制环境变量模板
echo ""
if [ ! -f config/.env ]; then
    echo "Creating .env file..."
    cp config/.env.example config/.env
    echo "⚠️  Please edit config/.env and set your NEXA_TOKEN"
else
    echo "✓ .env file already exists"
fi

# 检查可选依赖
echo ""
echo "Checking optional dependencies..."

# ffmpeg
if command -v ffmpeg &> /dev/null; then
    echo "✓ ffmpeg is installed"
    ffmpeg -version | head -n1
else
    echo "⚠️ ffmpeg not found. Media processing features will be disabled."
    echo "   Install with: brew install ffmpeg (macOS) or apt-get install ffmpeg (Linux)"
fi

# whisper.cpp
if command -v whisper-cli &> /dev/null; then
    echo "✓ whisper.cpp is installed"
else
    echo "⚠️ whisper.cpp not found. Transcription features will be disabled."
    echo "   Install with: brew install whisper-cpp"
fi

# 编译 TypeScript
echo ""
echo "Compiling TypeScript..."
npm run build

echo ""
echo "================================"
echo "Setup complete! 🎉"
echo "================================"
echo ""
echo "Next steps:"
echo "  1. Edit config/.env and set your NEXA_TOKEN"
echo "  2. Run: npm run dev -- fetch <url>"
echo "  3. Or start server: npm run dev -- server start"
echo ""
