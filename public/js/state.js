export const store = {
  me: null,
  groups: [],
  unread: 0,
};

// main.js fills these in; views call them to keep the sidebar and badges in sync.
export const app = {
  refreshGroups: async () => {},
  refreshUnread: async () => {},
  renderSidebar: () => {},
  start: async () => {},
};
