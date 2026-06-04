// 页面加载完成后执行
document.addEventListener('DOMContentLoaded', function() {
    // 平滑滚动效果
    const links = document.querySelectorAll('a[href^="#"]');
    
    links.forEach(link => {
        link.addEventListener('click', function(e) {
            e.preventDefault();
            
            const targetId = this.getAttribute('href');
            if (targetId === '#') return;
            
            const targetElement = document.querySelector(targetId);
            if (targetElement) {
                window.scrollTo({
                    top: targetElement.offsetTop - 70,
                    behavior: 'smooth'
                });
            }
        });
    });
    
    // 导航栏滚动效果
    window.addEventListener('scroll', function() {
        const header = document.querySelector('header');
        if (window.scrollY > 50) {
            header.style.boxShadow = '0 4px 20px rgba(0,0,0,0.15)';
            header.style.background = 'rgba(102, 126, 234, 0.95)';
        } else {
            header.style.boxShadow = '0 2px 10px rgba(0,0,0,0.1)';
            header.style.background = 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)';
        }
    });
    
    // 章节卡片悬停效果增强
    const cards = document.querySelectorAll('.chapter-card, .section');
    cards.forEach(card => {
        card.addEventListener('mouseenter', function() {
            this.style.transform = 'translateY(-5px)';
        });
        
        card.addEventListener('mouseleave', function() {
            this.style.transform = 'translateY(0)';
        });
    });
    
    // 图片加载优化
    const images = document.querySelectorAll('img');
    const imageObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const img = entry.target;
                img.src = img.dataset.src || img.src;
                imageObserver.unobserve(img);
            }
        });
    });
    
    images.forEach(img => imageObserver.observe(img));
    
    // 图片画廊功能
    setupImageGallery();
});

// 图片画廊功能
function setupImageGallery() {
    // 获取所有画廊项
    const galleryItems = document.querySelectorAll('.gallery-item');
    
    // 创建模态框
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.innerHTML = `
        <span class="close">&times;</span>
        <img class="modal-content" id="modal-img">
        <div class="modal-caption" id="modal-caption"></div>
        <a class="prev">&#10094;</a>
        <a class="next">&#10095;</a>
    `;
    
    document.body.appendChild(modal);
    
    const modalImg = document.getElementById('modal-img');
    const captionText = document.getElementById('modal-caption');
    const closeBtn = document.querySelector('.close');
    const prevBtn = document.querySelector('.prev');
    const nextBtn = document.querySelector('.next');
    
    let currentIndex = 0;
    let currentGallery = [];
    
    // 关闭模态框
    closeBtn.addEventListener('click', () => {
        modal.style.display = 'none';
    });
    
    // 点击模态框背景关闭
    modal.addEventListener('click', (e) => {
        if (e.target === modal) {
            modal.style.display = 'none';
        }
    });
    
    // 键盘事件
    document.addEventListener('keydown', (e) => {
        if (modal.style.display === 'block') {
            if (e.key === 'Escape') {
                modal.style.display = 'none';
            } else if (e.key === 'ArrowLeft') {
                showPrevImage();
            } else if (e.key === 'ArrowRight') {
                showNextImage();
            }
        }
    });
    
    // 上一张图片
    function showPrevImage() {
        currentIndex = (currentIndex - 1 + currentGallery.length) % currentGallery.length;
        updateModalContent();
    }
    
    // 下一张图片
    function showNextImage() {
        currentIndex = (currentIndex + 1) % currentGallery.length;
        updateModalContent();
    }
    
    // 更新模态框内容
    function updateModalContent() {
        const imgSrc = currentGallery[currentIndex].src;
        const altText = currentGallery[currentIndex].alt;
        
        modalImg.src = imgSrc;
        captionText.textContent = altText;
    }
    
    // 绑定点击事件到每个画廊项
    galleryItems.forEach(item => {
        item.addEventListener('click', function() {
            // 获取当前章节的所有图片
            const parentSection = this.closest('.section') || this.closest('.chapter-detail');
            currentGallery = Array.from(parentSection.querySelectorAll('.gallery-item img'));
            
            // 找到当前点击的图片索引
            const clickedImg = this.querySelector('img');
            currentIndex = currentGallery.findIndex(img => img.src === clickedImg.src);
            
            // 显示模态框
            updateModalContent();
            modal.style.display = 'block';
        });
    });
    
    // 绑定导航按钮事件
    prevBtn.addEventListener('click', showPrevImage);
    nextBtn.addEventListener('click', showNextImage);
}

// 科技感动态背景效果
function createParticles() {
    const canvas = document.createElement('canvas');
    canvas.id = 'particles';
    canvas.style.cssText = `
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        z-index: -1;
    `;
    
    document.body.appendChild(canvas);
    
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    
    const particles = [];
    const particleCount = 100;
    
    // 创建粒子
    for (let i = 0; i < particleCount; i++) {
        particles.push({
            x: Math.random() * canvas.width,
            y: Math.random() * canvas.height,
            radius: Math.random() * 2 + 1,
            speed: Math.random() * 0.5 + 0.1,
            angle: Math.random() * Math.PI * 2
        });
    }
    
    // 绘制粒子
    function drawParticles() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        
        ctx.fillStyle = 'rgba(116, 185, 255, 0.5)';
        
        particles.forEach(particle => {
            ctx.beginPath();
            ctx.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
            ctx.fill();
            
            // 更新粒子位置
            particle.x += Math.cos(particle.angle) * particle.speed;
            particle.y += Math.sin(particle.angle) * particle.speed;
            
            // 边界检测
            if (particle.x < 0 || particle.x > canvas.width) {
                particle.angle = Math.PI - particle.angle;
            }
            if (particle.y < 0 || particle.y > canvas.height) {
                particle.angle = -particle.angle;
            }
        });
        
        requestAnimationFrame(drawParticles);
    }
    
    drawParticles();
    
    // 窗口大小调整
    window.addEventListener('resize', () => {
        canvas.width = window.innerWidth;
        canvas.height = window.innerHeight;
    });
}

// 在主页创建粒子效果
if (window.location.pathname === '/index.html' || window.location.pathname === '/') {
    window.addEventListener('load', createParticles);
}