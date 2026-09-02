type ProductLogoProps = {
  className?: string;
  variant?: "wordmark" | "mark";
};

export function ProductLogo({ className = "", variant = "wordmark" }: ProductLogoProps) {
  return <img className={`product-logo ${className}`.trim()} src={variant === "mark" ? "/meta-code-mark.svg" : "/meta-code.svg"} alt="Meta Code" />;
}
