import React from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import FrontendApp from "./frontend/App";
import FrontendErrorBoundary from "./frontend/ErrorBoundary";
import "./frontend/styles/prototype.css";
import "./frontend/styles/production.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <FrontendErrorBoundary>
      <HashRouter>
        <FrontendApp />
      </HashRouter>
    </FrontendErrorBoundary>
  </React.StrictMode>,
);
