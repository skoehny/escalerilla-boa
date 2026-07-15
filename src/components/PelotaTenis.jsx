export default function PelotaTenis({ size = 27, style = {} }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" role="img"
         aria-label="pelota de tenis"
         style={{ verticalAlign: 'middle', marginLeft: 6, ...style }}>
      <circle cx="12" cy="12" r="10" fill="#9DBF3B"/>
      <path d="M5.05 5.95 C 9.4 9.3, 9.4 14.7, 5.05 18.05" fill="none"
            stroke="#F5F5EE" strokeWidth="1.6" strokeLinecap="round"/>
      <path d="M18.95 5.95 C 14.6 9.3, 14.6 14.7, 18.95 18.05" fill="none"
            stroke="#F5F5EE" strokeWidth="1.6" strokeLinecap="round"/>
    </svg>
  )
}
