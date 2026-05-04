'use strict';

document.addEventListener('DOMContentLoaded', () => {

  const navbar      = document.getElementById('navbar');
  const hamburger   = document.getElementById('hamburger');
  const navLinks    = document.getElementById('navLinks');
  const contactForm = document.getElementById('contactForm');

  // =============================================
  // 1. NAVBAR SCROLL EFFECT
  // Adds a white background to the navbar after scrolling 80px
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
