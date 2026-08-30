# Bili Live Caption - 本地实时识别服务(sherpa-onnx 中英双语流式 zipformer)
# 接收扩展发来的 16kHz/16bit/单声道 PCM,流式识别,JSON 推回:
#   {"text": "当前这句的完整文本", "final": false}   识别中,整句刷新
#   {"text": "定稿文本",           "final": true}    检测到停顿,这句定稿
import asyncio
import errno
import json
import logging
import re
import sys
from pathlib import Path

import numpy as np
import sherpa_onnx
import websockets

HOST = "127.0.0.1"
PORT = 8765
SAMPLE_RATE = 16000
MODEL_DIR = Path(__file__).resolve().parent / "model"

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(message)s", force=True)
log = logging.getLogger("blc")


def pick(name_int8: str, name_fp32: str) -> str:
    """优先用 int8 量化文件(小、快、精度损失可忽略)"""
    p = MODEL_DIR / name_int8
    return str(p if p.exists() else MODEL_DIR / name_fp32)


log.info("正在加载中英双语流式模型…")
recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
    tokens=str(MODEL_DIR / "tokens.txt"),
    encoder=pick("encoder-epoch-99-avg-1.int8.onnx", "encoder-epoch-99-avg-1.onnx"),
    decoder=pick("decoder-epoch-99-avg-1.int8.onnx", "decoder-epoch-99-avg-1.onnx"),
    joiner=pick("joiner-epoch-99-avg-1.int8.onnx", "joiner-epoch-99-avg-1.onnx"),
    num_threads=2,
    sample_rate=SAMPLE_RATE,
    feature_dim=80,
    # 束搜索比贪心解码准确率更高,代价是略多一点 CPU
    decoding_method="modified_beam_search",
    max_active_paths=4,
    enable_endpoint_detection=True,
    # 以下三个阈值单位都是「秒」(sherpa-onnx 默认 2.4 / 1.2 / 20)
    rule1_min_trailing_silence=2.4,   # 长静音断句
    rule2_min_trailing_silence=1.2,   # 已出字后的短静音断句
    # 兜底:连续说这么久还没停顿就强制断句。纪录片旁白常常一口气说很久,
    # 中间没有 1.2 秒的停顿,这条不生效的话一句会越积越长、字幕铺满还被裁掉。
    rule3_min_utterance_length=12,
)
log.info("模型加载完成")


def prettify(text: str) -> str:
    """模型输出的英文是全大写,转成正常句式:全小写 → 句首大写,I/I'm 保持大写"""
    t = text.lower()
    t = re.sub(r"\bi\b", "I", t)
    m = re.search(r"[a-z]", t)
    if m and m.start() == re.search(r"[a-zA-Z一-鿿]", t).start():
        t = t[: m.start()] + t[m.start()].upper() + t[m.start() + 1 :]
    return t


def decode(stream) -> tuple:
    """跑到没有可解码的帧为止,返回 (当前文本, 是否句尾)"""
    while recognizer.is_ready(stream):
        recognizer.decode_stream(stream)
    text = prettify(recognizer.get_result(stream))
    is_endpoint = recognizer.is_endpoint(stream)
    if is_endpoint:
        recognizer.reset(stream)
    return text, is_endpoint


async def handle(ws):
    log.info("客户端已连接: %s", ws.remote_address)
    stream = recognizer.create_stream()
    loop = asyncio.get_running_loop()
    last_sent = ""
    try:
        async for msg in ws:
            if isinstance(msg, bytes):
                pcm = np.frombuffer(msg, dtype=np.int16).astype(np.float32) / 32768.0
                stream.accept_waveform(SAMPLE_RATE, pcm)
                # 推理放线程池,避免阻塞 WebSocket 心跳
                text, final = await loop.run_in_executor(None, decode, stream)
                if final:
                    if text:
                        await ws.send(json.dumps({"text": text, "final": True}, ensure_ascii=False))
                    last_sent = ""
                elif text and text != last_sent:
                    await ws.send(json.dumps({"text": text, "final": False}, ensure_ascii=False))
                    last_sent = text
            else:
                data = json.loads(msg)
                if data.get("type") == "reset":  # 切换视频,丢弃识别上下文
                    stream = recognizer.create_stream()
                    last_sent = ""
                    log.info("已重置识别状态")
    except websockets.ConnectionClosed:
        pass
    finally:
        log.info("客户端断开: %s", ws.remote_address)


async def main():
    try:
        # max_size=None: 音频二进制帧不限大小; 一次只服务一个页面
        async with websockets.serve(handle, HOST, PORT, max_size=None):
            log.info("监听 ws://%s:%d", HOST, PORT)
            await asyncio.Future()
    except OSError as e:
        if e.errno == errno.EADDRINUSE:
            log.error(
                "端口 %d 被占用(通常是上一个 server.py 还在跑)。先执行:\n"
                "    lsof -ti:%d | xargs kill\n再重新启动。", PORT, PORT,
            )
            sys.exit(1)
        raise


if __name__ == "__main__":
    asyncio.run(main())
