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

function wireAccess() {
  const form = $("accessForm");
  if (!form) return;

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const email = $("accessEmail").value.trim();
    const status = $("accessStatus");
    const button = $("accessBtn");

    if (!email) {
      status.textContent = "Enter an email address first.";
      $("accessEmail").focus();
      return;
    }

    button.disabled = true;
    button.textContent = "Sending…";
    status.textContent = "";

    try {
      const response = await fetch("/api/site/notify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, source: "api" }),
      });
      const body = await response.json().catch(() => null);

      if (!response.ok) {
        status.textContent =
          body?.error?.message || "Could not add you to the list. Try again.";
        return;
      }

      button.textContent = "Request sent";
      status.textContent =
        body?.data?.message ||
        "You're on the API early-access list. We'll email you when your key is ready.";
      toast("Request received");
    } catch {
      status.textContent = "Could not reach the server. Check your connection and try again.";
    } finally {
      if (button.textContent === "Sending…") {
        button.disabled = false;
        button.textContent = "Request API access";
      }
    }
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
wireAccess();
wireNavHighlight();
