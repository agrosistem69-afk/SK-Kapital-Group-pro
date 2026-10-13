// Те же настройки, что в index.html (tailwind.config), чтобы в тестах страница выглядела как на сайте.
module.exports = {
    content: [require('path').join(__dirname, '..', 'index.html')],
    theme: {
        extend: {
            fontFamily: { sans: ['Inter', 'sans-serif'] },
            colors: { brand: { 50: '#f0f9ff', 100: '#e0f2fe', 200: '#bae6fd', 500: '#0284c7', 600: '#0369a1', 700: '#075985' } },
        },
    },
};
