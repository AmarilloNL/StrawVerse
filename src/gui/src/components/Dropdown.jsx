import { useState, useEffect, useRef } from "react";
import { ChevronDown } from "lucide-react";

export default function Dropdown({
  label,
  value,
  options = [],
  onChange,
  className = "",
  triggerClassName = "",
  menuClassName = "",
  itemClassName = "",
  minWidth,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const dropdownRef = useRef(null);

  useEffect(() => {
    const handleClickOutside = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);

  const selectedOption = options.find((opt) => opt.value === value);
  const displayText = selectedOption ? selectedOption.label : label;

  return (
    <div
      className={`input-group ${className}`}
      style={{
        minWidth: minWidth ? `${minWidth}px` : undefined,
        position: "relative",
      }}
      ref={dropdownRef}
    >
      <div
        className={`custom-dropdown-trigger ${isOpen ? "open" : ""} ${triggerClassName}`}
        onClick={() => setIsOpen(!isOpen)}
      >
        <span className="custom-dropdown-trigger-text">{displayText}</span>
        <ChevronDown className="custom-dropdown-chevron" size={16} />
      </div>

      {isOpen && (
        <div className={`custom-dropdown-menu ${menuClassName}`}>
          {options.map((opt) => (
            <div
              key={opt.value}
              className={`custom-dropdown-item ${opt.value === value ? "selected" : ""} ${opt.className || ""} ${itemClassName}`}
              onClick={() => {
                onChange(opt.value);
                setIsOpen(false);
              }}
            >
              {opt.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
