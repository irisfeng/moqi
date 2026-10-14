export function appendNotification(element: HTMLElement): void {
  (document.getElementById("notification-region") ?? document.body).append(element);
}
