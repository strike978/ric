// Clicking the toolbar icon opens the response page.
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
});

// Clicking a "retrying" failure notification opens the extension page, even if
// the page that created the notification has since been closed.
chrome.notifications.onClicked.addListener((notificationId) => {
  if (!notificationId.startsWith('ric-retry-')) return;

  chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
  chrome.notifications.clear(notificationId);
});
