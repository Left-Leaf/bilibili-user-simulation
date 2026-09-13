# 临时探针（验证后删除）：复核宿主（Python）侧的真实报错链路
#   Node 库 stdout 的 JSON → 宿主 json.loads → ensure_ascii=False + .encode('utf-8')
import json
import sys

with open(r'run\_probe-lines.json', encoding='utf-8') as f:
    data = json.load(f)  # 这一步会把 "\ud83d" 转义还原成**孤立代理字符**的 str

failed = False
for key in ('old', 'new'):
    s = data[key]
    lone = sorted({c for c in s if 0xD800 <= ord(c) <= 0xDFFF})
    try:
        payload = json.dumps({'text': s}, ensure_ascii=False).encode('utf-8')
        print(f'{key:>3}: encode OK      lone_surrogate={[hex(ord(c)) for c in lone]}  bytes={len(payload)}')
    except UnicodeEncodeError as e:
        failed = failed or key == 'new'
        print(f'{key:>3}: encode FAILED  {e}  lone_surrogate={[hex(ord(c)) for c in lone]}')

print('结果：', '❌ 新写法仍会让宿主报错' if failed else '✅ 旧写法报错、新写法正常（已修复）')
sys.exit(1 if failed else 0)
