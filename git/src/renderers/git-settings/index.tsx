import { render } from "solid-js/web";
import { GitSettings } from "./GitSettings";

const root = document.getElementById("app");
if (!root) {
  throw new Error("Git settings root element not found");
}

render(() => <GitSettings />, root);
