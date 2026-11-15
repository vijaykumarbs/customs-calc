const $ = (id) => document.getElementById(id);

function toast(message) {
  const el = $("toast");
  if (!el) return;
  el.textContent = message;
  el.classList.add("is-visible");
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => el.classList.remove("is-visible"), 2600);
}

async function copyText(value, successMessage) {
  try {
    await navigator.clipboard.writeText(value);
    toast(successMessage);
  } catch {
    toast("Copy failed — select the text manually");
  }
}

function wireCopyButtons() {
  document.querySelectorAll("[data-copy]").forEach((button) => {
    button.addEventListener("click", () => {
      const block = button.closest(".code-block");
      const text = block?.querySelector("code")?.textContent || "";
      copyText(text, "Copied to clipboard");
    });
  });
}

function wireSignup() {
  const form = $("signupForm");
  if (!form) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = $("signupEmail").value.trim();
    const status = $("signupStatus");
    const button = $("signupBtn");

    if (!email) {
      status.textContent = "Enter an email address first.";
      $("signupEmail").focus();
      return;
    }

    button.disabled = true;
    button.textContent = "Creating key…";
    status.textContent = "";

    try {
      const response = await fetch("/api/v1/signup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const body = await response.json().catch(() => null);

      if (!response.ok) {
        status.textContent = body?.error?.message || "Could not create a key. Try again.";
        return;
      }

      const key = body?.data?.key;
      if (!key) {
        status.textContent = "The server did not return a key. Try again.";
        return;
      }

      $("keyValue").textContent = key;
      $("keyResult").hidden = false;
      form.hidden = true;
      status.textContent = "";
      toast("API key created");
    } catch {
      status.textContent = "Could not reach the server. Check your connection and try again.";
    } finally {
      button.disabled = false;
      button.textContent = "Create my free API key";
    }
  });

  $("copyKey").addEventListener("click", () => {
    copyText($("keyValue").textContent, "API key copied");
  });
}

function wireNavHighlight() {
  const links = [...document.querySelectorAll(".docs-sidebar a")];
  if (!links.length || !("IntersectionObserver" in window)) return;

  const sections = links
    .map((link) => document.querySelector(link.getAttribute("href")))
    .filter(Boolean);

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        links.forEach((link) => {
          link.classList.toggle(
            "is-active",
            link.getAttribute("href") === `#${entry.target.id}`,
          );
        });
      }
    },
    { rootMargin: "-20% 0px -65% 0px" },
  );

  sections.forEach((section) => observer.observe(section));
}

$("year").textContent = String(new Date().getFullYear());
wireCopyButtons();
wireSignup();
wireNavHighlight();
