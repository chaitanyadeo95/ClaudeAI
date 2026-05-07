'use strict';

// =============================================
// AI NEURAL NETWORK BACKGROUND
// Nodes + connections + travelling pulse signals
// =============================================
(function initNeuralNet() {
  const canvas = document.getElementById('heroCanvas');
  if (!canvas) return;

  const ctx  = canvas.getContext('2d');
  const hero = document.getElementById('home');
  let animId;

  function resize() {
    canvas.width  = hero.offsetWidth;
    canvas.height = hero.offsetHeight;
    buildNodes();
  }

  // --- Nodes ---
  const NODE_COUNT = 55;
  const HUB_COUNT  = 8;      // larger glowing hub nodes
  const CONNECT_DIST = 160;
  let nodes = [];

  function buildNodes() {
    nodes = Array.from({ length: NODE_COUNT }, (_, i) => ({
      x:    Math.random() * canvas.width,
      y:    Math.random() * canvas.height,
      dx:   (Math.random() - 0.5) * 0.3,
      dy:   (Math.random() - 0.5) * 0.3,
      r:    i < HUB_COUNT ? 4 + Math.random() * 3 : 1.5 + Math.random() * 1.5,
      isHub: i < HUB_COUNT,
      pulse: 0,                // ring pulse 0→1
      pulseDir: Math.random() < 0.5 ? 1 : -1,
    }));
  }

  resize();
  window.addEventListener('resize', resize, { passive: true });

  // --- Travelling signals along edges ---
  const signals = [];
  function spawnSignal() {
    // pick two nearby nodes
    const a = nodes[Math.floor(Math.random() * nodes.length)];
    const b = nodes[Math.floor(Math.random() * nodes.length)];
    if (a === b) return;
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (d < CONNECT_DIST) {
      signals.push({ a, b, t: 0, speed: 0.008 + Math.random() * 0.012 });
    }
  }

  let frame = 0;

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    frame++;

    // Spawn a new signal occasionally
    if (frame % 18 === 0 && signals.length < 25) spawnSignal();

    // --- Draw edges ---
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const dx = nodes[i].x - nodes[j].x;
        const dy = nodes[i].y - nodes[j].y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < CONNECT_DIST) {
          const alpha = 0.18 * (1 - dist / CONNECT_DIST);
          ctx.beginPath();
          ctx.moveTo(nodes[i].x, nodes[i].y);
          ctx.lineTo(nodes[j].x, nodes[j].y);
          ctx.strokeStyle = `rgba(201,168,76,${alpha})`;
          ctx.lineWidth   = 0.8;
          ctx.stroke();
        }
      }
    }

    // --- Draw travelling signals ---
    for (let i = signals.length - 1; i >= 0; i--) {
      const s = signals[i];
      s.t += s.speed;
      if (s.t > 1) { signals.splice(i, 1); continue; }

      const sx = s.a.x + (s.b.x - s.a.x) * s.t;
      const sy = s.a.y + (s.b.y - s.a.y) * s.t;

      // Glowing dot travelling along the edge
      const grd = ctx.createRadialGradient(sx, sy, 0, sx, sy, 6);
      grd.addColorStop(0, 'rgba(201,168,76,0.9)');
      grd.addColorStop(1, 'rgba(201,168,76,0)');
      ctx.beginPath();
      ctx.arc(sx, sy, 6, 0, Math.PI * 2);
      ctx.fillStyle = grd;
      ctx.fill();
    }

    // --- Draw nodes ---
    nodes.forEach(n => {
      // Hub nodes get a pulsing outer ring
      if (n.isHub) {
        n.pulse += 0.015 * n.pulseDir;
        if (n.pulse > 1 || n.pulse < 0) n.pulseDir *= -1;
        const ringR = n.r + 6 + n.pulse * 8;
        ctx.beginPath();
        ctx.arc(n.x, n.y, ringR, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(201,168,76,${0.25 * n.pulse})`;
        ctx.lineWidth = 1.2;
        ctx.stroke();
      }

      // Node core
      const grd = ctx.createRadialGradient(n.x, n.y, 0, n.x, n.y, n.r * 2);
      grd.addColorStop(0, n.isHub ? 'rgba(201,168,76,0.95)' : 'rgba(201,168,76,0.7)');
      grd.addColorStop(1, 'rgba(201,168,76,0)');
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r * 2, 0, Math.PI * 2);
      ctx.fillStyle = grd;
      ctx.fill();

      // Move
      n.x += n.dx;
      n.y += n.dy;
      if (n.x < 0)             n.x = canvas.width;
      if (n.x > canvas.width)  n.x = 0;
      if (n.y < 0)             n.y = canvas.height;
      if (n.y > canvas.height) n.y = 0;
    });

    animId = requestAnimationFrame(draw);
  }

  draw();

  // Pause particles when hero is off-screen (saves CPU/battery)
  new IntersectionObserver(entries => {
    if (entries[0].isIntersecting) { if (!animId) draw(); }
    else { cancelAnimationFrame(animId); animId = null; }
  }).observe(hero);
})();

document.addEventListener('DOMContentLoaded', () => {

  const navbar      = document.getElementById('navbar');
  const hamburger   = document.getElementById('hamburger');
  const navLinks    = document.getElementById('navLinks');
  const contactForm = document.getElementById('contactForm');

  // =============================================
  // 1. NAVBAR SCROLL EFFECT
  // Adds shadow to navbar after scrolling 80px
  // =============================================
  const handleNavbarScroll = () => {
    if (window.scrollY > 80) {
      navbar.classList.add('navbar--scrolled');
    } else {
      navbar.classList.remove('navbar--scrolled');
    }
  };

  window.addEventListener('scroll', handleNavbarScroll, { passive: true });
  handleNavbarScroll(); // Run once on load in case page is already scrolled

  // =============================================
  // 2. MOBILE MENU TOGGLE
  // Opens/closes the nav on small screens
  // =============================================
  hamburger.addEventListener('click', () => {
    const isOpen = navLinks.classList.toggle('open');
    hamburger.classList.toggle('active', isOpen);
    hamburger.setAttribute('aria-expanded', String(isOpen));
    document.body.style.overflow = isOpen ? 'hidden' : '';
  });

  // Close menu when a nav link is clicked
  navLinks.querySelectorAll('a').forEach(link => {
    link.addEventListener('click', () => {
      navLinks.classList.remove('open');
      hamburger.classList.remove('active');
      hamburger.setAttribute('aria-expanded', 'false');
      document.body.style.overflow = '';
    });
  });

  // Close menu when clicking outside of it
  document.addEventListener('click', (e) => {
    if (navLinks.classList.contains('open') && !navbar.contains(e.target)) {
      navLinks.classList.remove('open');
      hamburger.classList.remove('active');
      hamburger.setAttribute('aria-expanded', 'false');
      document.body.style.overflow = '';
    }
  });

  // =============================================
  // 3. SMOOTH SCROLL FOR NAV LINKS (Safari fallback)
  // CSS scroll-behavior handles most browsers; this covers Safari
  // =============================================
  document.querySelectorAll('a[href^="#"]').forEach(link => {
    link.addEventListener('click', (e) => {
      const target = document.querySelector(link.getAttribute('href'));
      if (target) {
        e.preventDefault();
        target.scrollIntoView({ behavior: 'smooth' });
      }
    });
  });

  // =============================================
  // 4. SCROLL SPY — Active Nav Link Highlighting
  // Highlights the nav link for whichever section is currently in view
  // =============================================
  const sections  = document.querySelectorAll('section[id]');
  const navAnchors = document.querySelectorAll('.nav-links a[href^="#"]');

  const setActiveLink = (id) => {
    navAnchors.forEach(a => {
      a.classList.toggle('active', a.getAttribute('href') === `#${id}`);
    });
  };

  const spyObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        setActiveLink(entry.target.id);
      }
    });
  }, { threshold: 0.35, rootMargin: '-80px 0px 0px 0px' });

  sections.forEach(section => spyObserver.observe(section));

  // =============================================
  // 5. SCROLL-TRIGGERED FADE-IN ANIMATIONS
  // Elements with class "animate-hidden" fade in as they scroll into view
  // =============================================
  const animatables = document.querySelectorAll('.animate-hidden');

  const animObserver = new IntersectionObserver((entries) => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        entry.target.classList.add('animate-visible');
        animObserver.unobserve(entry.target); // Only animate once
      }
    });
  }, { threshold: 0.15, rootMargin: '0px 0px -40px 0px' });

  animatables.forEach(el => animObserver.observe(el));

  // =============================================
  // 6. CONTACT FORM — Validation + Submission
  // =============================================
  if (!contactForm) return;

  const nameInput    = document.getElementById('name');
  const emailInput   = document.getElementById('email');
  const messageInput = document.getElementById('message');
  const submitBtn    = document.getElementById('submitBtn');
  const formSuccess  = document.getElementById('formSuccess');
  const formErrorMsg = document.getElementById('formErrorMsg');

  const showError = (input, errorEl, message) => {
    input.classList.add('error');
    errorEl.textContent = message;
  };

  const clearError = (input, errorEl) => {
    input.classList.remove('error');
    errorEl.textContent = '';
  };

  // Inline validation on blur (when user leaves a field)
  nameInput.addEventListener('blur', () => {
    const err = document.getElementById('nameError');
    if (!nameInput.value.trim()) {
      showError(nameInput, err, 'Please enter your full name.');
    } else {
      clearError(nameInput, err);
    }
  });

  emailInput.addEventListener('blur', () => {
    const err = document.getElementById('emailError');
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailInput.value.trim()) {
      showError(emailInput, err, 'Please enter your email address.');
    } else if (!emailRe.test(emailInput.value.trim())) {
      showError(emailInput, err, 'Please enter a valid email address.');
    } else {
      clearError(emailInput, err);
    }
  });

  messageInput.addEventListener('blur', () => {
    const err = document.getElementById('messageError');
    if (!messageInput.value.trim()) {
      showError(messageInput, err, 'Please tell us a bit about your needs.');
    } else {
      clearError(messageInput, err);
    }
  });

  const validateForm = () => {
    let valid = true;
    const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!nameInput.value.trim()) {
      showError(nameInput, document.getElementById('nameError'), 'Please enter your full name.');
      valid = false;
    } else {
      clearError(nameInput, document.getElementById('nameError'));
    }

    if (!emailInput.value.trim()) {
      showError(emailInput, document.getElementById('emailError'), 'Please enter your email address.');
      valid = false;
    } else if (!emailRe.test(emailInput.value.trim())) {
      showError(emailInput, document.getElementById('emailError'), 'Please enter a valid email address.');
      valid = false;
    } else {
      clearError(emailInput, document.getElementById('emailError'));
    }

    if (!messageInput.value.trim()) {
      showError(messageInput, document.getElementById('messageError'), 'Please tell us a bit about your needs.');
      valid = false;
    } else {
      clearError(messageInput, document.getElementById('messageError'));
    }

    return valid;
  };

  contactForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    formSuccess.classList.remove('visible');
    formErrorMsg.classList.remove('visible');

    if (!validateForm()) return;

    const originalText = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';

    // Check if the user has replaced the Formspree placeholder
    const formAction = contactForm.getAttribute('action');
    const hasRealEndpoint = formAction && !formAction.includes('YOUR_FORM_ID');

    if (!hasRealEndpoint) {
      // No real endpoint yet — show success locally for preview purposes
      await new Promise(r => setTimeout(r, 800));
      contactForm.reset();
      submitBtn.textContent = originalText;
      submitBtn.disabled = false;
      formSuccess.classList.add('visible');
      return;
    }

    try {
      const res = await fetch(formAction, {
        method: 'POST',
        body: new FormData(contactForm),
        headers: { Accept: 'application/json' },
      });

      if (res.ok) {
        contactForm.reset();
        formSuccess.classList.add('visible');
      } else {
        formErrorMsg.classList.add('visible');
      }
    } catch {
      formErrorMsg.classList.add('visible');
    } finally {
      submitBtn.textContent = originalText;
      submitBtn.disabled = false;
    }
  });

});
