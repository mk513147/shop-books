import React, { useEffect } from "react";
import AppNavigator from "./src/navigation/AppNavigator";
import { initDatabase } from "./src/database/schema";

export default function App() {
	useEffect(() => {
		const setup = async () => {
			await initDatabase();
		};

		setup();
	}, []);

	return <AppNavigator />;
}
