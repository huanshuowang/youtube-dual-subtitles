#!/usr/bin/env bash
# Installs the local recogniser that HappySubs' live transcription talks to.
#
# Two ways in, both fine:
#   ./setup.sh                                    from a clone of this repo
#   curl -fsSL <raw url>/setup.sh | bash          on its own, no clone needed
#
# Nothing large is stored in this repository. The two Python files are a few KB;
# the model is ~500MB compressed and comes straight from the sherpa-onnx
# project's own GitHub release, so it costs this project no bandwidth and
# tracks upstream rather than a copy of it.
set -e

RAW="https://raw.githubusercontent.com/huanshuowang/happysubs/main"
MODEL_TARBALL="sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20"
MODEL_URL="https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL_TARBALL}.tar.bz2"
STANDALONE_DIR="happysubs-server"

# Running from a clone puts server/ next to this script. Piped from curl there
# is no script on disk and no repo, so fetch the two files we actually need.
SCRIPT_DIR=""
if [ -n "${BASH_SOURCE[0]:-}" ]; then
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" 2>/dev/null && pwd || true)"
fi

if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/server/server.py" ]; then
  echo "==> 使用仓库里的 server/"
  cd "$SCRIPT_DIR/server"
else
  echo "==> 未在仓库中运行,下载识别服务到 ./${STANDALONE_DIR}/"
  mkdir -p "$STANDALONE_DIR"
  cd "$STANDALONE_DIR"
  curl -fsSL --retry 3 -o server.py "$RAW/server/server.py"
  curl -fsSL --retry 3 -o requirements.txt "$RAW/server/requirements.txt"
fi

INSTALL_DIR="$(pwd)"

echo "==> 创建 Python 虚拟环境(venv 不能跨机器复用,每台机器建一次)"
rm -rf .venv
python3 -m venv .venv
.venv/bin/pip install -q --upgrade pip
.venv/bin/pip install -q -r requirements.txt

if [ -f model/tokens.txt ]; then
  echo "==> 模型已存在,跳过下载"
else
  echo "==> 下载中英双语流式模型(约 500MB 压缩包,解压后只保留 193MB)"
  echo "    来源:sherpa-onnx 官方 release"
  curl -L --retry 3 -o model.tar.bz2 "$MODEL_URL"
  tar xjf model.tar.bz2
  mv "$MODEL_TARBALL" model
  rm -f model.tar.bz2 \
        model/encoder-epoch-99-avg-1.onnx \
        model/decoder-epoch-99-avg-1.onnx \
        model/joiner-epoch-99-avg-1.onnx
  rm -rf model/test_wavs
fi

echo
echo "==> 完成。启动识别服务:"
echo
echo "    cd \"${INSTALL_DIR}\" && .venv/bin/python server.py"
echo
echo "    看到「监听 ws://127.0.0.1:8765」后,在插件弹窗切到「实时听译」点开启。"
