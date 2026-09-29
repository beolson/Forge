import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { Button } from "./button";

test("a disabled button cannot be activated", () => {
  const onClick = vi.fn();

  render(
    <Button disabled onClick={onClick}>
      Create project
    </Button>,
  );

  const button = screen.getByRole("button", { name: "Create project" });
  expect(button).toBeDisabled();
  fireEvent.click(button);
  expect(onClick).not.toHaveBeenCalled();
});
