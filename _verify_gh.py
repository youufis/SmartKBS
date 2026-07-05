import re, json, urllib.request

# Get rendered HTML from GitHub API
url = 'https://api.github.com/repos/youufis/SmartKBS/readme'
req = urllib.request.Request(url, headers={'Accept': 'application/vnd.github.v3.html'})
try:
    html = urllib.request.urlopen(req, timeout=15).read().decode('utf-8')
except Exception as e:
    print(f'API error: {e}')
    exit(1)

# Extract h2 anchors
pattern = re.compile(r'<a id="user-content-([^"]+)" class="anchor"[^>]*href="#([^"]+)"')
anchors = pattern.findall(html)
print('=== GitHub 实际 H2 锚点 ===')
gh_anchors = {}
for anchor_id, href in anchors:
    gh_anchors[href] = anchor_id
    print(f'  #{href}')

# Read our nav links
with open('README.md', 'r', encoding='utf-8') as f:
    content = f.read()

nav_pattern = re.compile(r'<a href="#([^"]+)">')
nav_links = nav_pattern.findall(content)
print(f'\n=== 导航链接匹配 ({len(nav_links)}个) ===')
all_ok = True
for l in nav_links:
    if l.startswith('user-content-'):
        continue
    status = '✅' if l in gh_anchors else '❌'
    if status == '❌':
        all_ok = False
    print(f'  {status} #{l}')
    
if all_ok:
    print('\n✅ 所有导航链接在 GitHub 上有效')
else:
    print('\n❌ 存在无效链接')
