const header = document.querySelector("[data-header]");
const menuButton = document.querySelector(".menu-toggle");
const navigation = document.querySelector(".site-nav");
const navLinks = navigation.querySelectorAll("a");
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const searchParams = new URLSearchParams(window.location.search);

const industryProfiles = {
  gym: {
    label: "Digital displays for gyms",
    line: "Keep members",
    accent: "moving",
    copy: "Promote classes, offers and motivation on freestanding screens delivered, set up and content-ready.",
    message: "a gym display setup",
  },
  mall: {
    label: "Digital displays for malls and retail",
    line: "Own the",
    accent: "walkway",
    copy: "Turn foot traffic into attention with bright, flexible digital promotions for malls and retail spaces.",
    message: "a mall or retail display setup",
  },
  events: {
    label: "Digital displays for events",
    line: "Run every",
    accent: "moment",
    copy: "Show schedules, sponsors, promotions and directions on screens delivered and ready for your event.",
    message: "an event display setup",
  },
  wedding: {
    label: "Digital displays for weddings",
    line: "Welcome them",
    accent: "well",
    copy: "Create elegant welcomes, schedules, menus and memorable visual moments for your celebration.",
    message: "a wedding display setup",
  },
  nightclub: {
    label: "Digital displays for nightlife",
    line: "Own the",
    accent: "night",
    copy: "Bring promotions, line-ups and animated campaigns into the room with screens built for high-energy spaces.",
    message: "a nightclub display setup",
  },
  property: {
    label: "Digital displays for property",
    line: "Move more",
    accent: "listings",
    copy: "Showcase property listings, developments and promotions in a format that is easy to update and hard to miss.",
    message: "a property display setup",
  },
  automotive: {
    label: "Digital displays for dealerships",
    line: "Move more",
    accent: "stock",
    copy: "Present vehicles, offers and finance information on flexible digital displays built for the showroom floor.",
    message: "a vehicle dealership display setup",
  },
  restaurant: {
    label: "Digital displays for menus and hospitality",
    line: "Make menus",
    accent: "move",
    copy: "Update menus, pricing, promotions and directions without replacing printed signage.",
    message: "a menu or hospitality display setup",
  },
};

const industryKey = searchParams.get("industry")?.toLowerCase() || "";
const industryProfile = industryProfiles[industryKey] || null;
const campaignContext = {
  industry: industryProfile ? industryKey : "general",
  source: searchParams.get("utm_source") || "direct",
  medium: searchParams.get("utm_medium") || "none",
  campaign: searchParams.get("utm_campaign") || "none",
};

window.dataLayer = window.dataLayer || [];

const trackEvent = (event, details = {}) => {
  const payload = { event, ...campaignContext, ...details };
  window.dataLayer.push(payload);
  document.dispatchEvent(new CustomEvent("onscene:analytics", { detail: payload }));
};

try {
  sessionStorage.setItem("onsceneCampaign", JSON.stringify(campaignContext));
} catch {
  // Tracking context still remains available for this page view.
}

if (industryProfile) {
  document.body.dataset.industry = industryKey;
  document.querySelector("[data-sector-label]").textContent = industryProfile.label;
  document.querySelector("[data-hero-line]").textContent = industryProfile.line;
  document.querySelector("[data-hero-accent]").textContent = industryProfile.accent;
  document.querySelector("[data-hero-copy]").textContent = industryProfile.copy;
  document.title = `OnScene for ${industryProfile.label.replace("Digital displays for ", "")} — Get seen`;
}

const quoteSubject = industryProfile?.message || "a digital display setup";
const whatsappMessage = [
  `Hi OnScene, I'm interested in a quote for ${quoteSubject}.`,
  "",
  "Company:",
  "Location:",
  "Date / duration:",
  "Number of screens:",
].join("\n");

document.querySelectorAll("[data-whatsapp]").forEach((link) => {
  const useCase = link.dataset.useCase;
  const message = useCase
    ? whatsappMessage.replace("\n\n", `\nUse case: ${useCase}\n\n`)
    : whatsappMessage;
  link.href = `https://wa.me/27837875826?text=${encodeURIComponent(message)}`;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
});

document.querySelectorAll("[data-track]").forEach((element) => {
  element.addEventListener("click", () => {
    trackEvent(element.dataset.track, {
      destination: element.href || "",
      useCase: element.dataset.useCase || "",
    });
  });
});

document.querySelectorAll(".faq-list details").forEach((item) => {
  item.addEventListener("toggle", () => {
    if (item.open) trackEvent("faq_open", { question: item.querySelector("summary").textContent.trim() });
  });
});

trackEvent("onscene_page_view");

const closeMenu = () => {
  menuButton.setAttribute("aria-expanded", "false");
  navigation.classList.remove("open");
  document.body.classList.remove("menu-open");
};

menuButton.addEventListener("click", () => {
  const isOpen = menuButton.getAttribute("aria-expanded") === "true";
  menuButton.setAttribute("aria-expanded", String(!isOpen));
  navigation.classList.toggle("open", !isOpen);
  document.body.classList.toggle("menu-open", !isOpen);
});

navLinks.forEach((link) => link.addEventListener("click", closeMenu));

window.addEventListener(
  "scroll",
  () => {
    header.classList.toggle("scrolled", window.scrollY > 32);
  },
  { passive: true },
);

const revealElements = document.querySelectorAll(".reveal");

if (reduceMotion.matches || !("IntersectionObserver" in window)) {
  revealElements.forEach((element) => element.classList.add("is-visible"));
} else {
  const revealObserver = new IntersectionObserver(
    (entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      });
    },
    { threshold: 0.14, rootMargin: "0px 0px -5%" },
  );

  revealElements.forEach((element) => revealObserver.observe(element));
}

if ("IntersectionObserver" in window) {
  const sectionObserver = new IntersectionObserver(
    (entries, observer) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        trackEvent("section_view", { section: entry.target.id });
        observer.unobserve(entry.target);
      });
    },
    { threshold: 0.35 },
  );

  document.querySelectorAll("#specs, #solutions, #wild, #faq, #contact").forEach((section) => {
    sectionObserver.observe(section);
  });
}

const parallaxLayer = document.querySelector("[data-parallax]");

if (parallaxLayer && !reduceMotion.matches) {
  window.addEventListener(
    "scroll",
    () => {
      const offset = Math.min(window.scrollY * 0.12, 90);
      parallaxLayer.style.transform = `translate3d(0, ${offset}px, 0) scale(1.01)`;
    },
    { passive: true },
  );
}

document.querySelector("[data-year]").textContent = new Date().getFullYear();
