// faq.js
document.addEventListener("DOMContentLoaded", function () {
  document.querySelectorAll(".faq-question").forEach((question) => {
    question.addEventListener("click", () => {
      const answer = question.nextElementSibling;
      const arrow = question.querySelector(".arrow");

      // Toggle current item
      answer.classList.toggle("active");
      arrow.classList.toggle("active");

      // Close other items
      document.querySelectorAll(".faq-answer").forEach((otherAnswer) => {
        if (otherAnswer !== answer && otherAnswer.classList.contains("active")) {
          otherAnswer.classList.remove("active");
          otherAnswer.previousElementSibling.querySelector(".arrow").classList.remove("active");
        }
      });
    });
  });
});

// Create toast element
const toastContainer = document.createElement("div");
toastContainer.className = "toast";
toastContainer.innerHTML = `
    <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="20 6 9 17 4 12"></polyline>
    </svg>
    <span>Link copied to clipboard!</span>
`;
document.body.appendChild(toastContainer);

// Handle copy functionality
document.querySelectorAll(".copy-button").forEach((button) => {
  button.addEventListener("click", async () => {
    const linkContainer = button.parentElement;
    const linkElement = linkContainer.querySelector(".copy-link");
    const linkText = linkElement.dataset.link;

    try {
      await navigator.clipboard.writeText(linkText);

      // Show toast
      toastContainer.classList.add("show");

      // Hide toast after 2 seconds
      setTimeout(() => {
        toastContainer.classList.remove("show");
      }, 3000);

      // Visual feedback on button
      button.style.color = "var(--success)";
      setTimeout(() => {
        button.style.color = "var(--text-secondary)";
      }, 1500);
    } catch (err) {
      console.error("Failed to copy text: ", err);
      toastContainer.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#ff4444" stroke-width="2">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="15" y1="9" x2="9" y2="15"></line>
                    <line x1="9" y1="9" x2="15" y2="15"></line>
                </svg>
                <span>Failed to copy link</span>
            `;
      toastContainer.classList.add("show");
      setTimeout(() => {
        toastContainer.classList.remove("show");
      }, 3000);
    }
  });
});

// Also allow clicking the code element itself
document.querySelectorAll(".copy-link").forEach((link) => {
  link.addEventListener("click", async () => {
    const linkText = link.dataset.link;
    try {
      await navigator.clipboard.writeText(linkText);
      toastContainer.classList.add("show");
      setTimeout(() => {
        toastContainer.classList.remove("show");
      }, 3000);
    } catch (err) {
      console.error("Failed to copy text: ", err);
    }
  });
});
