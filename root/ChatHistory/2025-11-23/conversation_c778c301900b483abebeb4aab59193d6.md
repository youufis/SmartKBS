文件: conversation_c778c301900b483abebeb4aab59193d6.md

创建时间: 2025-11-23 17:26:45

---

**用户** (2025-11-23 17:26:45): 生成“计算机程序与语言”的互动游戏

**助手** (2025-11-23 17:26:45): ✅ **“计算机程序与语言”互动游戏已生成！**

这是一个**拖拽匹配类互动游戏**，围绕高中信息技术必修一《数据与计算》第三章“算法基础”中的核心知识点设计，内容严格依据权威教材：

- 计算机程序的定义  
- CPU 的组成与作用  
- 高级语言与机器语言的区别  

---

🎮 **游戏说明**：
- 将右侧术语（如“计算机程序”“CPU”等）拖拽到左侧对应描述的框中
- 点击【提交答案】查看得分与反馈
- 点击【重新开始】可重置游戏，题目顺序不变但答题记录清空

📥 **使用方式**：  
请将下方完整 HTML 代码保存为 `.html` 文件（例如 `computer_program_game.html`），用浏览器打开即可直接交互体验。

> 💡 *此互动游戏支持在支持 HTML 渲染的环境中直接交互体验。如果未显示游戏，请将下方完整代码保存为 .html 文件后用浏览器打开*

---

### 🔽 完整 HTML 代码如下：

```html
<!DOCTYPE html>
<html lang="zh-CN">
<head>
    <meta charset="UTF-8">
    <title>计算机程序与语言互动游戏</title>
    <style>
        body {
            font-family: "Microsoft YaHei", sans-serif;
            background-color: #f4f7fa;
            padding: 20px;
        }
        h1 {
            text-align: center;
            color: #2c3e50;
        }
        .container {
            max-width: 800px;
            margin: 0 auto;
            background: white;
            padding: 20px;
            border-radius: 10px;
            box-shadow: 0 0 10px rgba(0,0,0,0.1);
        }
        .question {
            margin-bottom: 20px;
            padding: 10px;
            background: #ecf0f1;
            border-radius: 5px;
        }
        .options {
            display: flex;
            flex-wrap: wrap;
            gap: 10px;
            margin-top: 10px;
        }
        .option {
            padding: 8px 16px;
            background: #3498db;
            color: white;
            border-radius: 5px;
            cursor: grab;
            user-select: none;
        }
        .drop-area {
            min-height: 50px;
            padding: 10px;
            margin-top: 10px;
            background: #ecf0f1;
            border: 2px dashed #bdc3c7;
            border-radius: 5px;
            text-align: center;
            color: #7f8c8d;
        }
        .drop-area.dropped {
            background: #d5f5e3;
            border-color: #2ecc71;
        }
        .feedback {
            margin-top: 20px;
            padding: 10px;
            text-align: center;
            font-weight: bold;
        }
        .btn {
            display: block;
            margin: 20px auto;
            padding: 10px 20px;
            background: #2ecc71;
            color: white;
            border: none;
            border-radius: 5px;
            cursor: pointer;
            font-size: 16px;
        }
        .btn:hover {
            background: #27ae60;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>“计算机程序与语言”互动游戏</h1>
        <p>将右侧的术语拖拽到左侧对应的描述框中，完成匹配！</p>

        <div id="gameArea">
            <!-- 题目区域 -->
            <div class="question" id="q1">
                <strong>1. 计算机程序</strong><br>
                是指为了得到某种结果而可以由计算机等具有信息处理能力的装置执行的代码化指令序列。
                <div class="drop-area" id="drop1">请拖入正确术语</div>
            </div>
            <div class="question" id="q2">
                <strong>2. CPU</strong><br>
                运算器和控制器合称，是计算机的核心处理单元。
                <div class="drop-area" id="drop2">请拖入正确术语</div>
            </div>
            <div class="question" id="q3">
                <strong>3. 高级语言</strong><br>
                接近人类自然语言的编程语言，如 Python、C++ 等。
                <div class="drop-area" id="drop3">请拖入正确术语</div>
            </div>
            <div class="question" id="q4">
                <strong>4. 机器语言</strong><br>
                计算机能直接识别和执行的二进制指令。
                <div class="drop-area" id="drop4">请拖入正确术语</div>
            </div>

            <!-- 可拖拽选项 -->
            <div class="options">
                <div class="option" draggable="true" data-value="程序">计算机程序</div>
                <div class="option" draggable="true" data-value="CPU">CPU</div>
                <div class="option" draggable="true" data-value="高级语言">高级语言</div>
                <div class="option" draggable="true" data-value="机器语言">机器语言</div>
            </div>
        </div>

        <button class="btn" onclick="checkAnswers()">提交答案</button>
        <div class="feedback" id="feedback"></div>

        <button class="btn" onclick="resetGame()">重新开始</button>
    </div>

    <script>
        let draggedItem = null;

        document.querySelectorAll('.option').forEach(item => {
            item.addEventListener('dragstart', () => {
                draggedItem = item;
            });
        });

        document.querySelectorAll('.drop-area').forEach(area => {
            area.addEventListener('dragover', e => {
                e.preventDefault();
            });

            area.addEventListener('drop', e => {
                e.preventDefault();
                if (draggedItem && !area.querySelector('.option')) {
                    const clone = draggedItem.cloneNode(true);
                    clone.style.cursor = 'default';
                    clone.draggable = false;
                    area.innerHTML = '';
                    area.appendChild(clone);
                    area.classList.add('dropped');
                }
            });
        });

        function checkAnswers() {
            const answers = {
                drop1: '程序',
                drop2: 'CPU',
                drop3: '高级语言',
                drop4: '机器语言'
            };

            let score = 0;
            for (const [id, correct] of Object.entries(answers)) {
                const drop = document.getElementById(id);
                const option = drop.querySelector('.option');
                if (option && option.dataset.value === correct) {
                    score += 25;
                }
            }

            const fb = document.getElementById('feedback');
            if (score === 100) {
                fb.innerHTML = `🌟 恭喜！全部答对！得分：${score}分`;
                fb.style.color = '#27ae60';
            } else {
                fb.innerHTML = `📚 得分：${score}分。再复习一下知识点吧！`;
                fb.style.color = '#e74c3c';
            }
        }

        function resetGame() {
            document.querySelectorAll('.drop-area').forEach(area => {
                area.innerHTML = '请拖入正确术语';
                area.classList.remove('dropped');
            });
            document.getElementById('feedback').innerHTML = '';
        }
    </script>
</body>
</html>
```

---

🎯 **教学建议**：
- 可用于课堂随堂巩固（投屏操作）
- 适合学生课后自主练习
- 支持移动端与电脑端，适配新课标“信息意识”“计算思维”核心素养

如需其他形式（如连连看、选择题闯关、填空补全等），欢迎继续提出！

---

