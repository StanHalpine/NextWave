// Services submenu — "Services" expands a grouped list of every service
// instead of navigating straight to services.html, on mobile and desktop alike
var servicesItem = document.querySelector('.nav-item-services');
var servicesToggle = servicesItem && servicesItem.querySelector('[data-services-toggle]');

function closeServicesSubmenu() {
  if (!servicesItem) { return; }
  servicesItem.classList.remove('open');
  servicesToggle.setAttribute('aria-expanded', 'false');
}

if (servicesToggle) {
  servicesToggle.addEventListener('click', function (e) {
    e.preventDefault();
    var isOpen = servicesItem.classList.toggle('open');
    servicesToggle.setAttribute('aria-expanded', String(isOpen));
  });
  document.addEventListener('click', function (e) {
    if (servicesItem.classList.contains('open') && !servicesItem.contains(e.target)) {
      closeServicesSubmenu();
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { closeServicesSubmenu(); }
  });
}

// Mobile nav toggle
document.querySelectorAll('[data-nav-toggle]').forEach(function (btn) {
  btn.addEventListener('click', function () {
    var links = document.querySelector('.nav-links');
    links.classList.toggle('open');
    var expanded = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', String(!expanded));
    closeServicesSubmenu();
  });
});

// Scroll reveal
var revealEls = document.querySelectorAll('.reveal');
if ('IntersectionObserver' in window && revealEls.length) {
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (entry) {
      if (entry.isIntersecting) {
        entry.target.classList.add('is-visible');
        io.unobserve(entry.target);
      }
    });
  }, { threshold: 0.15 });
  revealEls.forEach(function (el) { io.observe(el); });
} else {
  revealEls.forEach(function (el) { el.classList.add('is-visible'); });
}

// Horizon line — draws once per page load, subtle re-trigger on repeated sections
document.querySelectorAll('.horizon').forEach(function (h, i) {
  var svg = h.querySelector('svg');
  if (svg) { svg.style.animationDelay = (i * 0.15) + 's'; }
});
